import { describe, expect, it } from 'vitest'

import { useReplayRigs, startConnected, statusSpans, expectedCommits, replay, type LogEntry } from './testing/e2eRig.js'
import { loadLiveFixture } from './testing/fixtures.js'
import { buildReplayScript, settle, waitUntil } from './testing/replay.js'
import { openOpencodeStore } from './transcript/OpencodeStore.js'

// More than one instance on one OpenCode database: two panes side by side,
// and a TUI that crashed and was respawned on the same session. Both are
// what a real machine does (OpenCode keeps every session in one file).
//
// Every expectation is derived from the recordings (their committable ids,
// their status spans), never from the code under test. The rig and oracles
// are shared in src/testing/e2eRig.ts.

const { rig } = useReplayRigs()

const entryIDs = (log: LogEntry[]) => log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id)
const turns = (log: LogEntry[], type: 'turn_started' | 'turn_completed') => log.filter(e => e.kind === 'semantic' && e.event.type === type).length

describe('OpencodeTerminalHeadless instances sharing one database', () => {
  it('two panes on one database each see only their own session, and the store reopens cleanly after both stop', async () => {
    const a = loadLiveFixture('plain.json')
    const b = loadLiveFixture('permission-once.json')
    expect(a.sessionID).not.toBe(b.sessionID)
    const ra = await rig(a)
    const rb = await rig(b, { sameDatabaseAs: ra })
    expect(rb.dbPath).toBe(ra.dbPath)
    await startConnected(ra)
    await startConnected(rb)
    // Interleaved: both replays run at once against the one file.
    await Promise.all([replay(ra, buildReplayScript(a)), replay(rb, buildReplayScript(b))])
    await waitUntil(() => !ra.headless.getActivity().active && !rb.headless.getActivity().active, 5000, 'both idle')
    // Negative window: nothing may cross over late either.
    await settle(60)

    expect(new Set(entryIDs(ra.log))).toEqual(expectedCommits(a).ids)
    expect(new Set(entryIDs(rb.log))).toEqual(expectedCommits(b).ids)
    expect(entryIDs(ra.log)).toHaveLength(expectedCommits(a).ids.size)
    expect(entryIDs(rb.log)).toHaveLength(expectedCommits(b).ids.size)
    expect(turns(ra.log, 'turn_started')).toBe(statusSpans(a))
    expect(turns(rb.log, 'turn_started')).toBe(statusSpans(b))
    expect(turns(ra.log, 'turn_completed')).toBe(statusSpans(a))
    expect(turns(rb.log, 'turn_completed')).toBe(statusSpans(b))
    // B's recorded permission is B's alone.
    expect(ra.log.some(e => e.kind === 'conditions' && Object.keys(e.snapshot.conditions).length > 0)).toBe(false)
    expect(rb.log.some(e => e.kind === 'conditions' && e.snapshot.conditions['opencode.permission'] !== undefined)).toBe(true)
    expect(ra.log.filter(e => e.kind === 'error')).toEqual([])
    expect(rb.log.filter(e => e.kind === 'error')).toEqual([])

    // The shared handle is reference counted: after both stop, a fresh open
    // is a real open, not a handle one of them still holds.
    await ra.headless.stop()
    await rb.headless.stop()
    const store = openOpencodeStore(ra.dbPath)
    try {
      expect(store.countMessages(a.sessionID)).toBeGreaterThan(0)
      expect(store.countMessages(b.sessionID)).toBeGreaterThan(0)
    } finally {
      store.release()
    }
  }, 20_000)

  it('a TUI that crashes mid-turn and is respawned on its session hands over exactly once, one turn pair each', async () => {
    const recording = loadLiveFixture('plain.json')
    const script = buildReplayScript(recording)
    // Crash right after the turn opened: the prompt's rows are committed, the
    // answer is not.
    const busyAt = script.findIndex(step => step.kind === 'sse' && step.event.type === 'session.status' && (step.event.properties?.status as { type?: string })?.type === 'busy')
    expect(busyAt).toBeGreaterThan(0)

    const first = await rig(recording)
    await startConnected(first)
    await replay(first, script.slice(0, busyAt + 1))
    await waitUntil(() => first.headless.getActivity().active, 3000, 'first instance busy')
    first.pty.exit(1)
    await waitUntil(() => first.log.some(e => e.kind === 'exit'), 3000, 'first exit')
    const firstEntries = entryIDs(first.log)
    const firstLength = first.log.length

    // Respawn: same database and session, a new server, PTY and instance.
    const second = await rig(recording, { sameDatabaseAs: first })
    await startConnected(second)
    await replay(second, script.slice(busyAt + 1))
    await waitUntil(() => !second.headless.getActivity().active && turns(second.log, 'turn_completed') === 1, 5000, 'second instance idle')
    // Negative window: the first instance stays silent, whatever arrives.
    await settle(60)

    expect(first.log.filter(e => e.kind === 'exit')).toEqual([{ kind: 'exit', exitCode: 1, signal: undefined }])
    expect(first.log.length).toBe(firstLength)
    expect(turns(first.log, 'turn_started')).toBe(1)
    expect(turns(first.log, 'turn_completed')).toBe(1)
    expect(turns(second.log, 'turn_started')).toBe(1)
    expect(turns(second.log, 'turn_completed')).toBe(1)
    // The recording's committable rows arrive exactly once across both:
    // what was committed before the crash through the first instance, the
    // rest through the second. Neither reports an error.
    const secondEntries = entryIDs(second.log)
    expect(new Set([...firstEntries, ...secondEntries])).toEqual(expectedCommits(recording).ids)
    expect(firstEntries.length + secondEntries.length).toBe(expectedCommits(recording).ids.size)
    expect(secondEntries.some(id => firstEntries.includes(id))).toBe(false)
    expect(first.log.filter(e => e.kind === 'error')).toEqual([])
    expect(second.log.filter(e => e.kind === 'error')).toEqual([])
  }, 20_000)
})
