// End-to-end rig for this package's own system tests: a complete
// OpencodeTerminalHeadless against a replay server (real sockets) and a
// SQLite file written the way OpenCode's projectors write it.
//
// WHY a module instead of helpers at the top of one test file: the end-to-end
// suite outgrew the testing standard's size guidance, and is split by
// behavioral owner (replay, conditions, re-sync, degradation, lifecycle,
// instances). Every part needs the same rig, oracles and cleanup.
//
// Package-internal. Not re-exported from `src/testing/index.ts`, because it
// imports vitest hooks, and hosts (Agent Code) build their own harness on the
// exported replay primitives instead.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach } from 'vitest'

import type { SemanticEvent } from '../channels/types.js'
import type { ConditionSnapshot } from '../conditions/core/contract.js'
import type { OpencodeTerminalLaunch } from '../launch/prepareLaunch.js'
import { OpencodeTerminalHeadless, type OpencodeTerminalError } from '../OpencodeTerminalHeadless.js'
import type { OpencodeStore } from '../transcript/OpencodeStore.js'
import type { OpencodeMessageRecord } from '../transcript/records.js'
import { LiveFixtureWriter } from './fixtureDatabase.js'
import { listLiveFixtures, type LiveFixture } from './fixtures.js'
import { FakePty, playReplay, ReplayServer, sessionRowFor, waitUntil, type ReplayOptions, type ReplayStep } from './replay.js'

export const RIG_USER = 'opencode'
export const RIG_PASSWORD = 'replay-password'

/** Every recording of a TUI that started normally (port-conflict never serves). */
export const REPLAYABLE_RECORDINGS = listLiveFixtures().filter(name => name !== 'port-conflict.json')

export type LogEntry =
  | { kind: 'activity'; active: boolean; status: string | null }
  | { kind: 'entry'; record: OpencodeMessageRecord }
  | { kind: 'semantic'; event: SemanticEvent }
  | { kind: 'conditions'; snapshot: ConditionSnapshot<'opencode'> }
  | { kind: 'error'; error: OpencodeTerminalError }
  | { kind: 'live-state'; connected: boolean; reason?: string }
  | { kind: 'session-switched'; from: string; to: string }
  | { kind: 'exit'; exitCode: number; signal?: number }

export type Rig = {
  headless: OpencodeTerminalHeadless
  server: ReplayServer
  writer: LiveFixtureWriter
  dbPath: string
  /** The recording's session: what the headless observes and what `replay` writes rows under. */
  sessionID: string
  pty: FakePty
  log: LogEntry[]
  committedFiles: string[]
}

export type RigOverrides = {
  fetch?: typeof fetch
  password?: string
  url?: string
  dbPath?: string | null
  deadlineMs?: number
  openStore?: (dbPath: string) => OpencodeStore
  resyncRetryMs?: number
  /**
   * Share an existing rig's database: same SQLite file and writer, but a new
   * server (new port and password in real life), PTY and headless. With the
   * same recording it is a TUI that crashed and was started again on its
   * session; with another recording it is a second pane on the same machine,
   * whose session row is added to the shared file.
   */
  sameDatabaseAs?: Rig
  /**
   * Extra columns for the session row this rig seeds — `agent` and `model` in
   * practice, so a test can stand a session up on a NON-default agent. That
   * case is the whole point of reading the selection: a session already on
   * `build` cannot show whether we preserved it or defaulted into it.
   */
  sessionRow?: Record<string, unknown>
}

/**
 * Registers per-test setup and cleanup in the calling file and returns the rig
 * factory. Call once at the top level of a test file.
 *
 * Cleanup is registered as each resource is acquired, and every release is
 * attempted independently, so a test that fails halfway through setup (or a
 * release that throws) cannot leak a server, a SQLite writer or a live
 * headless into the next test.
 */
export function useReplayRigs(): {
  rig: (recording: LiveFixture, overrides?: RigOverrides) => Promise<Rig>
  dir: () => string
} {
  let dir = ''
  let cleanups: Array<() => unknown> = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oth-e2e-'))
    cleanups = []
  })
  afterEach(async () => {
    const failures: unknown[] = []
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    rmSync(dir, { recursive: true, force: true })
    if (failures.length > 0) throw failures[0]
  })

  let count = 0
  const rig = async (recording: LiveFixture, overrides: RigOverrides = {}): Promise<Rig> => {
    const shared = overrides.sameDatabaseAs
    const dbPath = shared ? shared.dbPath : join(dir, `${recording.scenario}-${count++}.db`)
    const seedRow = { ...sessionRowFor(recording.sessionID), ...overrides.sessionRow }
    const writer = shared ? shared.writer : new LiveFixtureWriter(dbPath, recording.sessionID, seedRow)
    if (!shared) cleanups.push(() => writer.close())
    else if (shared.sessionID !== recording.sessionID) writer.addSession({ ...seedRow, id: recording.sessionID })
    const server = new ReplayServer({ username: RIG_USER, password: RIG_PASSWORD })
    cleanups.push(() => server.close())
    await server.listen()
    const launch: OpencodeTerminalLaunch = {
      binary: 'opencode',
      args: [],
      env: {},
      sessionID: recording.sessionID,
      server: { url: overrides.url ?? server.url, username: RIG_USER, password: overrides.password ?? RIG_PASSWORD },
      dbPath: overrides.dbPath === undefined ? dbPath : overrides.dbPath,
    }
    const pty = new FakePty()
    const headless = new OpencodeTerminalHeadless({
      pty,
      cwd: '/sandbox/project',
      launch,
      fetch: overrides.fetch,
      heartbeatMs: 0,
      durablePollIntervalMs: 40,
      liveConnectDeadlineMs: overrides.deadlineMs ?? 5000,
      sseInitialBackoffMs: 20,
      sseMaxBackoffMs: 80,
      resyncRetryMs: overrides.resyncRetryMs ?? 20,
      ...(overrides.openStore ? { openStore: overrides.openStore } : {}),
    })
    cleanups.push(() => headless.stop())
    const log: LogEntry[] = []
    const committedFiles: string[] = []
    headless.on('activity', state => log.push({ kind: 'activity', ...state }))
    headless.on('entry', record => log.push({ kind: 'entry', record }))
    headless.on('semantic', event => log.push({ kind: 'semantic', event }))
    headless.on('conditions', snapshot => log.push({ kind: 'conditions', snapshot }))
    headless.on('transcript-error', error => log.push({ kind: 'error', error }))
    headless.on('live-state', state => log.push({ kind: 'live-state', ...state }))
    headless.on('session-switched', event => log.push({ kind: 'session-switched', ...event }))
    headless.on('exit', event => log.push({ kind: 'exit', ...event }))
    headless.committed.on('entry', (event: { file: string }) => committedFiles.push(event.file))
    return { headless, server, writer, dbPath, sessionID: recording.sessionID, pty, log, committedFiles }
  }

  return { rig, dir: () => dir }
}

/**
 * Start and wait for the steady state a replay begins from: the stream is
 * open and the first re-sync has applied every part. Waits on the headless's
 * own progress seam, not on a sleep after the server saw a request.
 */
export async function startConnected(r: Rig): Promise<void> {
  await r.headless.start()
  await waitUntil(() => r.headless.getLiveProgress().reconciled, 5000, 'first re-sync applied')
}

/**
 * Play a script through the rig one bus event at a time: after each event is
 * sent, wait until the headless has applied it. Stops waiting when no stream
 * could receive it or the stream is down (a test that drops the connection
 * mid-replay), because that event will never arrive.
 */
export async function replay(r: Rig, script: readonly ReplayStep[], options: Omit<ReplayOptions, 'afterSse' | 'writeAs'> = {}): Promise<void> {
  await playReplay(script, r.writer, r.server, {
    ...options,
    writeAs: r.sessionID,
    afterSse: async (_step, streams) => {
      if (streams === 0) return
      // Read synchronously right after the write: the client cannot have
      // applied it yet, because its socket read needs another event-loop turn.
      const before = r.headless.getLiveProgress().busEvents
      await waitUntil(() => {
        const progress = r.headless.getLiveProgress()
        return progress.busEvents > before || !progress.connected
      }, 5000, 'bus event applied')
    },
  })
}

/** Busy→idle spans for the recording's own session, read off its bus events. */
export function statusSpans(recording: LiveFixture): number {
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

/**
 * Committable ids implied by the recording's durable rows (its final state),
 * and the text the recording's last answer ended with.
 *
 * `finalAnswerText` is the oracle for `turn_completed.fullText`: of the
 * assistants the recording completed, the last one (in completion order) that
 * has text, with each text part's LAST written text, parts in id order,
 * joined. It is read off the recorded rows only, never off a record the
 * package assembled, so an assembly bug that drops or reorders text fails the
 * comparison instead of feeding it.
 */
export function expectedCommits(recording: LiveFixture): { ids: Set<string>; finalAnswerText: string } {
  const infos = new Map<string, { role: string; completed: boolean }>()
  const partsOf = new Map<string, Set<string>>()
  const textParts = new Map<string, Map<string, string>>() // message id → part id → last text
  const completionOrder: string[] = []
  for (const row of recording.durable) {
    if (row.aggregateID !== recording.sessionID) continue
    if (row.type === 'message.updated.1') {
      const info = row.data.info as { id: string; role: string; time?: { completed?: number } }
      const completed = typeof info.time?.completed === 'number'
      if (info.role === 'assistant' && completed && !infos.get(info.id)?.completed) completionOrder.push(info.id)
      infos.set(info.id, { role: info.role, completed })
    }
    if (row.type === 'message.part.updated.1') {
      const part = row.data.part as { id: string; messageID: string; type: string; text?: string }
      const set = partsOf.get(part.messageID) ?? new Set<string>()
      set.add(part.id)
      partsOf.set(part.messageID, set)
      if (part.type === 'text' && typeof part.text === 'string') {
        const texts = textParts.get(part.messageID) ?? new Map<string, string>()
        texts.set(part.id, part.text)
        textParts.set(part.messageID, texts)
      }
    }
  }
  const ids = new Set<string>()
  for (const [id, info] of infos) {
    if (info.role === 'user' && (partsOf.get(id)?.size ?? 0) > 0) ids.add(id)
    if (info.role === 'assistant' && info.completed) ids.add(id)
  }
  let finalAnswerText = ''
  for (const id of completionOrder) {
    const texts = textParts.get(id)
    if (!texts) continue
    const text = [...texts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value).join('')
    if (text) finalAnswerText = text
  }
  return { ids, finalAnswerText }
}

export function indexOfKind(log: LogEntry[], predicate: (entry: LogEntry) => boolean, from = 0): number {
  for (let i = from; i < log.length; i += 1) if (predicate(log[i]!)) return i
  return -1
}
