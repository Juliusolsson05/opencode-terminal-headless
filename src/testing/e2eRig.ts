// End-to-end rig for this package's own system tests: a complete
// OpencodeTerminalHeadless against a replay server (real sockets) and a
// SQLite file written the way OpenCode's projectors write it.
//
// WHY a module instead of helpers at the top of one test file: the end-to-end
// suite outgrew the testing standard's size guidance, and is split by
// behavioral owner (replay, conditions, degradation, lifecycle). Every part
// needs the same rig, oracles and cleanup.
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
import { FakePty, ReplayServer, sessionRowFor, settle, waitUntil } from './replay.js'

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
  | { kind: 'exit'; exitCode: number; signal?: number }

export type Rig = {
  headless: OpencodeTerminalHeadless
  server: ReplayServer
  writer: LiveFixtureWriter
  pty: FakePty
  log: LogEntry[]
  committedFiles: string[]
}

export type RigOverrides = {
  password?: string
  url?: string
  dbPath?: string | null
  deadlineMs?: number
  openStore?: (dbPath: string) => OpencodeStore
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
    const dbPath = join(dir, `${recording.scenario}-${count++}.db`)
    const writer = new LiveFixtureWriter(dbPath, recording.sessionID, sessionRowFor(recording.sessionID))
    cleanups.push(() => writer.close())
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
      heartbeatMs: 0,
      durablePollIntervalMs: 40,
      liveConnectDeadlineMs: overrides.deadlineMs ?? 5000,
      sseInitialBackoffMs: 20,
      sseMaxBackoffMs: 80,
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
    headless.on('exit', event => log.push({ kind: 'exit', ...event }))
    headless.committed.on('entry', (event: { file: string }) => committedFiles.push(event.file))
    return { headless, server, writer, pty, log, committedFiles }
  }

  return { rig, dir: () => dir }
}

export async function startConnected(r: Rig): Promise<void> {
  await r.headless.start()
  await waitUntil(() => r.log.some(e => e.kind === 'live-state' && e.connected), 5000, 'live connection')
  // Let the post-connect re-sync finish before replaying, so the test observes
  // the steady state rather than racing the first snapshot.
  await waitUntil(() => r.server.calls.some(c => c.path === '/question'), 5000, 're-sync')
  await settle(20)
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

/** Committable ids implied by the recording's durable rows (its final state). */
export function expectedCommits(recording: LiveFixture): { ids: Set<string>; lastAssistantTexts: string[] } {
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

export function indexOfKind(log: LogEntry[], predicate: (entry: LogEntry) => boolean, from = 0): number {
  for (let i = from; i < log.length; i += 1) if (predicate(log[i]!)) return i
  return -1
}
