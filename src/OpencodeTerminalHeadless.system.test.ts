import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SemanticEvent } from './channels/types.js'
import type { ConditionSnapshot } from './conditions/core/contract.js'
import { allocateLoopbackPort } from './launch/port.js'
import type { OpencodeTerminalLaunch } from './launch/prepareLaunch.js'
import { OpencodeTerminalHeadless, type OpencodeTerminalError } from './OpencodeTerminalHeadless.js'
import { LiveFixtureWriter } from './testing/fixtureDatabase.js'
import { listLiveFixtures, loadLiveFixture, type LiveFixture } from './testing/fixtures.js'
import { buildReplayScript, FakePty, playReplay, ReplayServer, sessionRowFor, settle, waitUntil, type ReplayStep } from './testing/replay.js'
import { openOpencodeStore, OpencodeStoreError, type OpencodeStore } from './transcript/OpencodeStore.js'
import { loadSqlite } from './transcript/sqlite.js'
import type { OpencodeMessageRecord } from './transcript/records.js'

// End-to-end over the whole package: every Stage 0 live recording is re-enacted
// over real sockets (a local stand-in for the TUI's server) and a real SQLite
// file (written the way OpenCode's projectors write), while the complete
// OpencodeTerminalHeadless runs against it exactly as Agent Code will run it.
//
// Every expectation is derived from the recording itself — its status spans,
// its durable rows, its request ids — never from the code under test.

const USER = 'opencode'
const PASSWORD = 'replay-password'
const RECORDINGS = listLiveFixtures().filter(name => name !== 'port-conflict.json')

type LogEntry =
  | { kind: 'activity'; active: boolean; status: string | null }
  | { kind: 'entry'; record: OpencodeMessageRecord }
  | { kind: 'semantic'; event: SemanticEvent }
  | { kind: 'conditions'; snapshot: ConditionSnapshot<'opencode'> }
  | { kind: 'error'; error: OpencodeTerminalError }
  | { kind: 'live-state'; connected: boolean; reason?: string }
  | { kind: 'exit' }

type Rig = {
  headless: OpencodeTerminalHeadless
  server: ReplayServer
  writer: LiveFixtureWriter
  pty: FakePty
  log: LogEntry[]
  committedFiles: string[]
}

let dir: string
let rigs: Rig[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oth-e2e-'))
  rigs = []
})
afterEach(async () => {
  for (const rig of rigs) {
    await rig.headless.stop()
    await rig.server.close()
    rig.writer.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

async function rig(
  recording: LiveFixture,
  overrides: { password?: string; url?: string; dbPath?: string | null; deadlineMs?: number; openStore?: (dbPath: string) => OpencodeStore } = {},
): Promise<Rig> {
  const dbPath = join(dir, `${recording.scenario}-${rigs.length}.db`)
  const writer = new LiveFixtureWriter(dbPath, recording.sessionID, sessionRowFor(recording.sessionID))
  const server = new ReplayServer({ username: USER, password: PASSWORD })
  await server.listen()
  const launch: OpencodeTerminalLaunch = {
    binary: 'opencode',
    args: [],
    env: {},
    sessionID: recording.sessionID,
    server: { url: overrides.url ?? server.url, username: USER, password: overrides.password ?? PASSWORD },
    dbPath: overrides.dbPath === undefined ? dbPath : overrides.dbPath,
  }
  const pty = new FakePty()
  const headless = new OpencodeTerminalHeadless({
    pty,
    cwd: '/sandbox/project',
    launch,
    heartbeatMs: 0,
    durablePollIntervalMs: 40,
    liveConnectDeadlineMs: overrides.deadlineMs ?? 5000,
    sseInitialBackoffMs: 20,
    sseMaxBackoffMs: 80,
    ...(overrides.openStore ? { openStore: overrides.openStore } : {}),
  })
  const log: LogEntry[] = []
  const committedFiles: string[] = []
  headless.on('activity', state => log.push({ kind: 'activity', ...state }))
  headless.on('entry', record => log.push({ kind: 'entry', record }))
  headless.on('semantic', event => log.push({ kind: 'semantic', event }))
  headless.on('conditions', snapshot => log.push({ kind: 'conditions', snapshot }))
  headless.on('transcript-error', error => log.push({ kind: 'error', error }))
  headless.on('live-state', state => log.push({ kind: 'live-state', ...state }))
  headless.on('exit', () => log.push({ kind: 'exit' }))
  headless.committed.on('entry', (event: { file: string }) => committedFiles.push(event.file))
  const made = { headless, server, writer, pty, log, committedFiles }
  rigs.push(made)
  return made
}

async function startConnected(r: Rig): Promise<void> {
  await r.headless.start()
  await waitUntil(() => r.log.some(e => e.kind === 'live-state' && e.connected), 5000, 'live connection')
  // Let the post-connect re-sync finish before replaying, so the test observes
  // the steady state rather than racing the first snapshot.
  await waitUntil(() => r.server.calls.some(c => c.path === '/question'), 5000, 're-sync')
  await settle(20)
}

function statusSpans(recording: LiveFixture): number {
  let spans = 0
  let busy = false
  for (const { event } of recording.sse) {
    if (event.properties?.sessionID !== recording.sessionID) continue
    const type = event.type === 'session.idle' ? 'idle' : event.type === 'session.status' ? (event.properties.status as { type: string }).type : null
    if ((type === 'busy' || type === 'retry') && !busy) { busy = true; spans += 1 }
    if (type === 'idle') busy = false
  }
  return spans
}

/** Committable ids implied by the recording's durable rows (its final state). */
function expectedCommits(recording: LiveFixture): { ids: Set<string>; lastAssistantTexts: string[] } {
  const infos = new Map<string, { role: string; completed: boolean }>()
  const partsOf = new Map<string, Set<string>>()
  const textOf = new Map<string, string>()
  for (const row of recording.durable) {
    if (row.aggregateID !== recording.sessionID) continue
    if (row.type === 'message.updated.1') {
      const info = row.data.info as { id: string; role: string; time?: { completed?: number } }
      infos.set(info.id, { role: info.role, completed: typeof info.time?.completed === 'number' })
    }
    if (row.type === 'message.part.updated.1') {
      const part = row.data.part as { id: string; messageID: string; type: string; text?: string }
      const set = partsOf.get(part.messageID) ?? new Set<string>()
      set.add(part.id)
      partsOf.set(part.messageID, set)
      if (part.type === 'text' && typeof part.text === 'string') textOf.set(part.messageID, part.text)
    }
  }
  const ids = new Set<string>()
  const lastAssistantTexts: string[] = []
  for (const [id, info] of infos) {
    if (info.role === 'user' && (partsOf.get(id)?.size ?? 0) > 0) ids.add(id)
    if (info.role === 'assistant' && info.completed) {
      ids.add(id)
      if (textOf.has(id)) lastAssistantTexts.push(textOf.get(id)!)
    }
  }
  return { ids, lastAssistantTexts }
}

function indexOfKind(log: LogEntry[], predicate: (entry: LogEntry) => boolean, from = 0): number {
  for (let i = from; i < log.length; i += 1) if (predicate(log[i]!)) return i
  return -1
}

describe('OpencodeTerminalHeadless replaying recorded TUI sessions end to end', () => {
  for (const name of RECORDINGS) {
    it(`${name}: status, turns, committed messages, conditions and their order`, async () => {
      const recording = loadLiveFixture(name)
      const r = await rig(recording)
      await startConnected(r)
      await playReplay(buildReplayScript(recording), r.writer, r.server)
      await waitUntil(() => !r.headless.getActivity().active, 3000, 'final idle')
      await settle(60)

      expect(r.log.filter(e => e.kind === 'error')).toEqual([])

      // Committed messages: exactly the committable ones, each once, with the
      // pane's transcript locator on the committed channel.
      const entries = r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record)
      const ids = entries.map(record => record.info.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(new Set(ids)).toEqual(expectedCommits(recording).ids)
      expect(new Set(r.committedFiles)).toEqual(new Set([`opencode://session/${recording.sessionID}`]))
      expect(entries.every(record => record.info.sessionID === recording.sessionID)).toBe(true)

      // Turns: one per recorded busy→idle span, paired and never overlapping.
      const semantic = r.log.filter((e): e is Extract<LogEntry, { kind: 'semantic' }> => e.kind === 'semantic').map(e => e.event)
      const starts = semantic.filter(e => e.type === 'turn_started')
      const completes = semantic.filter(e => e.type === 'turn_completed')
      expect(starts).toHaveLength(statusSpans(recording))
      expect(completes.map(e => e.turnId)).toEqual(starts.map(e => e.turnId))

      // Activity: busy inside every turn, idle at the end, never idle mid-turn.
      let inTurn = false
      for (const entry of r.log) {
        if (entry.kind === 'semantic' && entry.event.type === 'turn_started') inTurn = true
        if (entry.kind === 'semantic' && entry.event.type === 'turn_completed') inTurn = false
        if (entry.kind === 'activity' && inTurn) expect(entry.active).toBe(true)
      }
      const activity = r.log.filter((e): e is Extract<LogEntry, { kind: 'activity' }> => e.kind === 'activity')
      expect(activity[0]?.active).toBe(true)
      expect(activity[activity.length - 1]?.active).toBe(false)

      // The order Agent Code's orchestration depends on, per turn: the turn's
      // committed answer, then turn_completed, then phase idle, then inactive.
      for (const complete of completes) {
        const completeAt = indexOfKind(r.log, e => e.kind === 'semantic' && e.event === complete)
        const startAt = indexOfKind(r.log, e => e.kind === 'semantic' && e.event.type === 'turn_started' && e.event.turnId === complete.turnId)
        const answersInTurn = r.log
          .map((e, i) => ({ e, i }))
          .filter(({ e, i }) => i > startAt && i < completeAt && e.kind === 'entry' && e.record.info.role === 'assistant')
        expect(answersInTurn.length).toBeGreaterThan(0)
        const idleAt = indexOfKind(r.log, e => e.kind === 'semantic' && e.event.type === 'stream_phase' && e.event.phase === 'idle', completeAt)
        const inactiveAt = indexOfKind(r.log, e => e.kind === 'activity' && !e.active, idleAt)
        expect(idleAt).toBeGreaterThan(completeAt)
        expect(inactiveAt).toBeGreaterThan(idleAt)
        // The completed turn carries the answer the user saw.
        const lastAnswer = (answersInTurn[answersInTurn.length - 1]!.e as Extract<LogEntry, { kind: 'entry' }>).record
        const lastText = lastAnswer.parts.filter(p => p.type === 'text').map(p => String(p.text)).join('')
        if (lastText) expect((complete as Extract<SemanticEvent, { type: 'turn_completed' }>).fullText).toBe(lastText)
      }

      // Conditions: the first snapshot is the explicit empty one; recorded
      // requests surface with their ids and clear again.
      const snapshots = r.log.filter((e): e is Extract<LogEntry, { kind: 'conditions' }> => e.kind === 'conditions').map(e => e.snapshot)
      expect(snapshots[0]?.conditions).toEqual({})
      expect(snapshots[snapshots.length - 1]?.conditions).toEqual({})
      const asked = recording.sse.find(({ event }) => event.type === 'permission.asked' || event.type === 'question.asked')?.event
      if (asked) {
        const kind = asked.type === 'permission.asked' ? 'opencode.permission' : 'opencode.question'
        const idKey = kind === 'opencode.permission' ? 'requestID' : 'questionID'
        const visible = snapshots.find(s => s.conditions[kind])
        expect((visible!.conditions[kind]!.state as Record<string, unknown>)[idKey]).toBe(asked.properties?.id)
      } else {
        expect(snapshots.every(s => Object.keys(s.conditions).length === 0)).toBe(true)
      }
    })
  }
})

describe('OpencodeTerminalHeadless answering conditions through the TUI server', () => {
  async function pauseAt(recording: LiveFixture, type: string, onPause: (r: Rig) => Promise<void>): Promise<Rig> {
    const r = await rig(recording)
    await startConnected(r)
    let paused = false
    await playReplay(buildReplayScript(recording), r.writer, r.server, {
      beforeStep: async (step: ReplayStep) => {
        if (!paused && step.kind === 'sse' && step.event.type === type) {
          paused = true
          await settle(30)
          await onPause(r)
        }
      },
    })
    return r
  }

  function latestConditions(r: Rig): ConditionSnapshot<'opencode'> {
    return [...r.log].reverse().find((e): e is Extract<LogEntry, { kind: 'conditions' }> => e.kind === 'conditions')!.snapshot
  }

  it('replies "once" to a recorded permission, clearing the badge before the bus confirms', async () => {
    const recording = loadLiveFixture('permission-once.json')
    const asked = recording.sse.find(({ event }) => event.type === 'permission.asked')!.event
    let conditionsAfterReply = -1
    const r = await pauseAt(recording, 'permission.replied', async paused => {
      const record = latestConditions(paused).conditions['opencode.permission']!
      const once = record.actions.find(action => action.label === 'Allow once')!
      expect(once.kind).toBe('custom')
      const result = await paused.headless.resolveConditionAction(once as Extract<typeof once, { kind: 'custom' }>)
      expect(result).toEqual({ ok: true })
      expect(latestConditions(paused).conditions).toEqual({})
      conditionsAfterReply = paused.log.filter(e => e.kind === 'conditions').length
    })
    const post = r.server.calls.filter(c => c.method === 'POST')
    expect(post).toEqual([{ method: 'POST', path: `/permission/${asked.properties!.id}/reply`, body: '{"reply":"once"}', authorized: true }])
    // The recorded permission.replied that followed changed nothing further.
    expect(r.log.filter(e => e.kind === 'conditions').length).toBe(conditionsAfterReply)
  })

  it('maps the Reject action to the recorded reject reply', async () => {
    const recording = loadLiveFixture('permission-reject.json')
    const r = await pauseAt(recording, 'permission.replied', async paused => {
      const reject = latestConditions(paused).conditions['opencode.permission']!.actions.find(action => action.label === 'Reject')!
      expect(await paused.headless.resolveConditionAction(reject as Extract<typeof reject, { kind: 'custom' }>)).toEqual({ ok: true })
    })
    expect(r.server.calls.find(c => c.method === 'POST')?.body).toBe('{"reply":"reject"}')
  })

  it('rejects a recorded question', async () => {
    const recording = loadLiveFixture('question-reject.json')
    const asked = recording.sse.find(({ event }) => event.type === 'question.asked')!.event
    const r = await pauseAt(recording, 'question.rejected', async paused => {
      const reject = latestConditions(paused).conditions['opencode.question']!.actions[0]!
      expect(await paused.headless.resolveConditionAction(reject as Extract<typeof reject, { kind: 'custom' }>)).toEqual({ ok: true })
      expect(latestConditions(paused).conditions).toEqual({})
    })
    expect(r.server.calls.find(c => c.method === 'POST')?.path).toBe(`/question/${asked.properties!.id}/reject`)
  })

  it('refuses malformed and unknown actions without calling the server', async () => {
    const r = await rig(loadLiveFixture('plain.json'))
    await startConnected(r)
    expect(await r.headless.resolveConditionAction({ kind: 'custom', id: 'x', label: 'x', name: 'opencode.permission.reply', payload: { requestID: 'per_1', reply: 'maybe' } })).toEqual({ ok: false, reason: 'invalid-payload' })
    expect(await r.headless.resolveConditionAction({ kind: 'custom', id: 'x', label: 'x', name: 'claude.trust-dialog.accept' })).toEqual({ ok: false, reason: 'no-resolver' })
    expect(r.server.calls.filter(c => c.method === 'POST')).toEqual([])
  })
})

describe('OpencodeTerminalHeadless degrading honestly', () => {
  it('ends a turn that finished while the stream was down, via re-sync, with the answer first', async () => {
    const recording = loadLiveFixture('plain.json')
    const r = await rig(recording)
    await startConnected(r)
    let dropped = false
    await playReplay(buildReplayScript(recording), r.writer, r.server, {
      beforeStep: async step => {
        // Drop the stream once the turn has visibly started (the prompt's own
        // parts arrive BEFORE busy, so waiting on the turn_started event — not
        // on some part — is what makes "mid-turn" true). The rest of the turn,
        // including its idle, then happens while nobody is listening.
        if (!dropped && step.kind === 'sse' && r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_started')) {
          dropped = true
          r.server.setRefusing(true)
          r.server.dropStreams()
          await waitUntil(() => r.log.some(e => e.kind === 'live-state' && !e.connected), 3000, 'disconnect')
        }
      },
    })
    expect(dropped).toBe(true)
    expect(r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_completed')).toBe(false)
    // While disconnected the pane must still read as busy: the turn is open.
    expect(r.headless.getActivity().active).toBe(true)
    r.server.setRefusing(false)
    await waitUntil(() => r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_completed'), 5000, 'turn end after re-sync')
    await settle(60)
    const completeAt = indexOfKind(r.log, e => e.kind === 'semantic' && e.event.type === 'turn_completed')
    const answerAt = indexOfKind(r.log, e => e.kind === 'entry' && e.record.info.role === 'assistant')
    expect(answerAt).toBeGreaterThanOrEqual(0)
    expect(answerAt).toBeLessThan(completeAt)
    expect(r.headless.getActivity().active).toBe(false)
    const ids = r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id)
    expect(new Set(ids)).toEqual(expectedCommits(recording).ids)
    // WHY a longer budget: this test waits for a real disconnect, replays a
    // turn nobody hears, then waits for a real reconnect and re-sync — three
    // bounded waits whose sum exceeds the 5 s default.
  }, 20_000)

  it('delivers a turn that happened entirely while disconnected, without leaving the pane busy', async () => {
    // Found by the replays: a prompt's own parts reach the bus BEFORE busy, so
    // a stream lost at that moment misses the whole turn. The durable poll must
    // still deliver the conversation, and re-sync must not invent a turn.
    const recording = loadLiveFixture('plain.json')
    const r = await rig(recording)
    await startConnected(r)
    let dropped = false
    await playReplay(buildReplayScript(recording), r.writer, r.server, {
      beforeStep: async step => {
        if (!dropped && step.kind === 'sse' && step.event.type === 'message.updated') {
          dropped = true
          r.server.setRefusing(true)
          r.server.dropStreams()
          await waitUntil(() => r.log.some(e => e.kind === 'live-state' && !e.connected), 3000, 'disconnect')
        }
      },
    })
    const expected = expectedCommits(recording).ids
    const committed = () => new Set(r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id))
    await waitUntil(() => committed().size === expected.size, 3000, 'durable poll while disconnected')
    r.server.setRefusing(false)
    await waitUntil(() => r.server.calls.filter(c => c.path === '/question').length >= 2, 5000, 're-sync after reconnect')
    await settle(60)
    expect(committed()).toEqual(expected)
    expect(r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_started')).toBe(false)
    expect(r.headless.getActivity().active).toBe(false)
  }, 20_000)

  it('reports server-unreachable after the deadline and still commits from the durable log', async () => {
    const recording = loadLiveFixture('plain.json')
    const closedPort = await allocateLoopbackPort()
    const r = await rig(recording, { url: `http://127.0.0.1:${closedPort}`, deadlineMs: 300 })
    await r.headless.start()
    await waitUntil(() => r.log.some(e => e.kind === 'live-state' && e.reason === 'server-unreachable'), 3000, 'unreachable')
    for (const step of buildReplayScript(recording)) if (step.kind === 'durable') r.writer.apply(step.row.type, step.row.data)
    // Prompts commit when their answer appears and answers on completion, so
    // the durable poll alone delivers the whole conversation.
    const expected = expectedCommits(recording).ids
    const committed = () => new Set(r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id))
    await waitUntil(() => committed().size === expected.size, 3000, 'durable poll')
    expect(committed()).toEqual(expected)
    // Without the live channel there is no status source at all: honest idle.
    expect(r.log.some(e => e.kind === 'activity' && e.active)).toBe(false)
  })

  it('never connects with the wrong password, and says so', async () => {
    const r = await rig(loadLiveFixture('plain.json'), { password: 'not-the-password', deadlineMs: 300 })
    await r.headless.start()
    await waitUntil(() => r.log.some(e => e.kind === 'live-state' && e.reason === 'server-unreachable'), 3000, 'unreachable')
    expect(r.server.calls.length).toBeGreaterThan(0)
    expect(r.server.calls.every(c => !c.authorized)).toBe(true)
  })

  it('disables only the durable channel for a database it refuses', async () => {
    const recording = loadLiveFixture('plain.json')
    const foreign = join(dir, 'foreign.db')
    const { DatabaseSync } = loadSqlite()
    const db = new (DatabaseSync as unknown as new (p: string) => { exec(s: string): void; close(): void })(foreign)
    db.exec('CREATE TABLE unrelated (x integer)')
    db.close()
    const r = await rig(recording, { dbPath: foreign })
    await startConnected(r)
    await playReplay(buildReplayScript(recording), r.writer, r.server)
    await waitUntil(() => r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_completed'), 3000, 'turn end')
    const errors = r.log.filter((e): e is Extract<LogEntry, { kind: 'error' }> => e.kind === 'error').map(e => e.error)
    expect(errors).toEqual([expect.objectContaining({ channel: 'durable', code: 'unsupported_schema' })])
    expect(r.log.some(e => e.kind === 'entry')).toBe(false)
    expect(r.log.some(e => e.kind === 'activity' && e.active)).toBe(true)
  })

  it('retries a database that is busy at open instead of disabling the durable channel', async () => {
    const recording = loadLiveFixture('plain.json')
    // Two opens meet a writer recovering the WAL; the third gets through.
    let refusals = 2
    let opened = false
    const r = await rig(recording, {
      openStore: path => {
        if (refusals > 0) {
          refusals -= 1
          throw new OpencodeStoreError('busy', 'OpenCode schema check: database busy')
        }
        opened = true
        return openOpencodeStore(path)
      },
    })
    await startConnected(r)
    await waitUntil(() => opened, 3000, 'durable open retried')
    await playReplay(buildReplayScript(recording), r.writer, r.server)
    await waitUntil(() => r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_completed'), 5000, 'turn end')
    await settle(60)
    expect(r.log.filter(e => e.kind === 'error')).toEqual([])
    const ids = r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id)
    expect(new Set(ids)).toEqual(expectedCommits(recording).ids)
    // The answer still precedes the turn's end, as with a healthy open.
    const completeAt = indexOfKind(r.log, e => e.kind === 'semantic' && e.event.type === 'turn_completed')
    expect(indexOfKind(r.log, e => e.kind === 'entry' && e.record.info.role === 'assistant')).toBeLessThan(completeAt)
  })

  it('ignores a re-sync snapshot that a newer connection has already superseded', async () => {
    const recording = loadLiveFixture('plain.json')
    const r = await rig(recording)
    await startConnected(r)
    const status = (type: string) => ({ type: 'session.status', properties: { sessionID: recording.sessionID, status: { type } } })
    r.server.send(status('busy'))
    await waitUntil(() => r.headless.getActivity().active, 3000, 'busy')

    // Connection 1's re-sync reads "busy", but its answer is held back.
    const stale = r.server.holdNext('/session/status')
    r.server.dropStreams()
    await stale.arrived
    // Connection 1 drops as well, and the turn ends while nobody listens.
    r.server.setRefusing(true)
    r.server.dropStreams()
    await waitUntil(() => r.log.filter(e => e.kind === 'live-state' && !e.connected).length >= 2, 3000, 'second disconnect')
    r.server.send(status('idle'))
    // Connection 2 re-syncs to idle and closes the turn.
    r.server.setRefusing(false)
    await waitUntil(() => !r.headless.getActivity().active, 5000, 'idle from the newer re-sync')
    const turnsBefore = r.log.filter(e => e.kind === 'semantic' && e.event.type === 'turn_started').length

    // Connection 1's stale "busy" finally arrives. It must not re-open the turn.
    stale.release()
    await settle(150)
    expect(r.headless.getActivity().active).toBe(false)
    expect(r.log.filter(e => e.kind === 'semantic' && e.event.type === 'turn_started').length).toBe(turnsBefore)
  }, 20_000)

  it('applies the parts of a re-sync that answered, and reports the rest as live state, not a transcript error', async () => {
    const recording = loadLiveFixture('plain.json')
    const r = await rig(recording)
    await startConnected(r)
    const status = (type: string) => ({ type: 'session.status', properties: { sessionID: recording.sessionID, status: { type } } })
    r.server.send(status('busy'))
    await waitUntil(() => r.headless.getActivity().active, 3000, 'busy')
    // The stream drops, the turn ends unheard, and /question starts failing.
    r.server.setRefusing(true)
    r.server.dropStreams()
    await waitUntil(() => r.log.some(e => e.kind === 'live-state' && !e.connected), 3000, 'disconnect')
    r.server.send(status('idle'))
    r.server.setFailing('/question', true)
    r.server.setRefusing(false)
    // The status part still ends the turn.
    await waitUntil(() => !r.headless.getActivity().active, 5000, 'idle from a partial re-sync')
    await waitUntil(
      () => r.log.some(e => e.kind === 'live-state' && e.connected && (e.reason ?? '').startsWith('resync-incomplete') && (e.reason ?? '').includes('/question')),
      3000,
      'incomplete re-sync reported',
    )
    expect(r.log.filter(e => e.kind === 'error')).toEqual([])
  }, 20_000)

  it('reports a missing database path instead of guessing one', async () => {
    const r = await rig(loadLiveFixture('plain.json'), { dbPath: null })
    await r.headless.start()
    expect(r.log.find(e => e.kind === 'error')).toMatchObject({ error: { channel: 'durable', code: 'db_path_unavailable' } })
  })
})

describe('OpencodeTerminalHeadless lifecycle', () => {
  it('closes the open turn once when the TUI exits mid-turn, then goes quiet', async () => {
    const recording = loadLiveFixture('permission-once.json')
    const r = await rig(recording)
    await startConnected(r)
    const script = buildReplayScript(recording)
    const askedAt = script.findIndex(step => step.kind === 'sse' && step.event.type === 'permission.asked')
    await playReplay(script.slice(0, askedAt + 1), r.writer, r.server)
    await waitUntil(() => r.log.some(e => e.kind === 'conditions' && Object.keys(e.snapshot.conditions).length > 0), 3000, 'permission visible')
    r.pty.exit(137, 9)
    await settle(20)
    const tail = r.log.slice(indexOfKind(r.log, e => e.kind === 'semantic' && e.event.type === 'turn_completed'))
    expect(tail.map(e => (e.kind === 'semantic' ? e.event.type : e.kind))).toEqual(['turn_completed', 'stream_phase', 'activity', 'conditions', 'exit'])
    expect((tail[3] as Extract<LogEntry, { kind: 'conditions' }>).snapshot.conditions).toEqual({})
    const before = r.log.length
    for (const step of script.slice(askedAt + 1)) if (step.kind === 'sse') r.server.send(step.event)
    await settle(40)
    expect(r.log.length).toBe(before)
    expect(r.log.filter(e => e.kind === 'exit')).toHaveLength(1)
    expect(r.headless.isExited()).toBe(true)
  })

  it('stop() is idempotent before, after and around start(), and silences everything', async () => {
    const recording = loadLiveFixture('plain.json')
    const early = await rig(recording)
    await early.headless.stop()
    await early.headless.start()
    await early.headless.stop()
    expect(early.log).toEqual([])
    expect(early.pty.listenerCount()).toBe(0)

    const r = await rig(recording)
    await startConnected(r)
    await r.headless.stop()
    await r.headless.stop()
    const before = r.log.length
    await playReplay(buildReplayScript(recording), r.writer, r.server)
    r.pty.exit(0)
    await settle(60)
    expect(r.log.length).toBe(before)
    expect(r.pty.listenerCount()).toBe(0)
  })

  it('writes prompts to the caller-owned PTY as one bracketed paste and forwards resizes', async () => {
    const r = await rig(loadLiveFixture('plain.json'))
    await r.headless.start()
    r.headless.pasteAndSubmit('line one\nline two')
    r.headless.resize(100, 30)
    expect(r.pty.writes).toEqual(['\x1b[200~line one\nline two\x1b[201~\r'])
    expect(r.pty.sizes).toEqual([[100, 30]])
  })
})
