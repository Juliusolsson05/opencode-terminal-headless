import { describe, expect, it } from 'vitest'

import { useReplayRigs, startConnected, indexOfKind, type LogEntry } from './testing/e2eRig.js'
import { loadLiveFixture } from './testing/fixtures.js'
import { buildReplayScript, playReplay, settle, waitUntil } from './testing/replay.js'

// Start, stop and exit: what the host sees when the TUI ends, and that a
// stopped instance stays silent.
//
// Every expectation is derived from the recording itself (its status spans,
// its durable rows, its request ids), never from the code under test. The
// rig and oracles are shared in src/testing/e2eRig.ts.

const { rig } = useReplayRigs()

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
