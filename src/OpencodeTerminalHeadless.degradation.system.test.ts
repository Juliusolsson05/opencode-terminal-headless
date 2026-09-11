import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { allocateLoopbackPort } from './launch/port.js'
import { useReplayRigs, startConnected, expectedCommits, indexOfKind, type LogEntry } from './testing/e2eRig.js'
import { loadLiveFixture } from './testing/fixtures.js'
import { buildReplayScript, playReplay, settle, waitUntil } from './testing/replay.js'
import { openOpencodeStore, OpencodeStoreError } from './transcript/OpencodeStore.js'
import { loadSqlite } from './transcript/sqlite.js'

// Losing a channel, or part of one, without reporting wrong data: dropped
// streams and re-syncs, an unreachable server, a refused or busy database.
//
// Every expectation is derived from the recording itself (its status spans,
// its durable rows, its request ids), never from the code under test. The
// rig and oracles are shared in src/testing/e2eRig.ts.

const { rig, dir } = useReplayRigs()

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
    const foreign = join(dir(), 'foreign.db')
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
