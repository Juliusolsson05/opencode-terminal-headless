import { describe, expect, it } from 'vitest'

import { useReplayRigs, startConnected, indexOfKind, replay, type LogEntry } from './testing/e2eRig.js'
import { loadLiveFixture } from './testing/fixtures.js'
import { buildReplayScript, settle, waitUntil } from './testing/replay.js'
import { openOpencodeStore } from './transcript/OpencodeStore.js'

// Start, stop and exit: what the host sees when the TUI ends, and that a
// stopped or exited instance stays silent.
//
// Every expectation is derived from the recording itself (its status spans,
// its durable rows, its request ids, its PTY exit), never from the code under
// test. The rig and oracles are shared in src/testing/e2eRig.ts.

const { rig } = useReplayRigs()

describe('OpencodeTerminalHeadless lifecycle', () => {
  it('closes the open turn once when the TUI exits mid-turn, reports the exit as the PTY did, then goes quiet', async () => {
    const recording = loadLiveFixture('permission-once.json')
    const r = await rig(recording)
    await startConnected(r)
    const script = buildReplayScript(recording)
    const askedAt = script.findIndex(step => step.kind === 'sse' && step.event.type === 'permission.asked')
    await replay(r, script.slice(0, askedAt + 1))
    await waitUntil(() => r.log.some(e => e.kind === 'conditions' && Object.keys(e.snapshot.conditions).length > 0), 3000, 'permission visible')
    expect(r.pty.listenerCount()).toBe(1)
    // A SIGKILLed TUI: node-pty reports the signal next to the exit code.
    r.pty.exit(137, 9)
    await waitUntil(() => r.log.some(e => e.kind === 'exit'), 3000, 'exit reported')
    const tail = r.log.slice(indexOfKind(r.log, e => e.kind === 'semantic' && e.event.type === 'turn_completed'))
    expect(tail.map(e => (e.kind === 'semantic' ? e.event.type : e.kind))).toEqual(['turn_completed', 'stream_phase', 'activity', 'conditions', 'exit'])
    expect((tail[3] as Extract<LogEntry, { kind: 'conditions' }>).snapshot.conditions).toEqual({})
    expect(tail[4]).toEqual({ kind: 'exit', exitCode: 137, signal: 9 })
    // Natural exit releases the PTY subscription without a stop(): a host
    // that keeps exited PTYs around must not keep this instance alive too.
    expect(r.pty.listenerCount()).toBe(0)
    const before = r.log.length
    for (const step of script.slice(askedAt + 1)) if (step.kind === 'sse') r.server.send(step.event)
    // Negative window: a slow machine can only deliver a stray event later,
    // and the instance must ignore it whenever it comes.
    await settle(40)
    expect(r.log.length).toBe(before)
    expect(r.log.filter(e => e.kind === 'exit')).toHaveLength(1)
    expect(r.headless.isExited()).toBe(true)
  })

  it('delivers a TUI exit that happened before start(), once, and then does no network or store work', async () => {
    let opens = 0
    const r = await rig(loadLiveFixture('plain.json'), {
      openStore: path => {
        opens += 1
        return openOpencodeStore(path)
      },
    })
    // The CLI died between the host's construction and its start() (bad
    // arguments, a missing session): nobody had subscribed yet.
    r.pty.exit(12)
    expect(r.headless.isExited()).toBe(true)
    await r.headless.start()
    expect(r.log).toEqual([{ kind: 'exit', exitCode: 12 }])
    await r.headless.start()
    await r.headless.stop()
    await r.headless.stop()
    // Negative window: no stream attempt, no re-sync, no durable open, ever.
    await settle(60)
    expect(r.log).toEqual([{ kind: 'exit', exitCode: 12 }])
    expect(r.server.calls).toEqual([])
    expect(opens).toBe(0)
    expect(r.pty.listenerCount()).toBe(0)
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
    await replay(r, buildReplayScript(recording))
    r.pty.exit(0)
    // Negative window, as above.
    await settle(60)
    expect(r.log.length).toBe(before)
    expect(r.pty.listenerCount()).toBe(0)
  })

  it('a stop() from inside a startup transcript-error handler ends start(): no later events, no HTTP', async () => {
    // R2-F4: a host that retires the backend the moment the durable channel
    // reports a missing database used to see the live channel open, a
    // condition snapshot and reconnect attempts after its stop().
    //
    // Timers are not counted here: every timer the package arms is unref'd,
    // and process.getActiveResourcesInfo() does not list unref'd timers, so
    // such a count could never fail. The exact count is asserted with fake
    // timers in OpencodeTerminalHeadless.startup.test.ts; this test proves the
    // same stop over real sockets, by what the server saw.
    const r = await rig(loadLiveFixture('plain.json'), { dbPath: null })
    r.headless.on('transcript-error', () => { void r.headless.stop() })
    await r.headless.start()
    expect(r.log).toEqual([{ kind: 'error', error: expect.objectContaining({ channel: 'durable', code: 'db_path_unavailable' }) }])
    // Negative window: a stream opened after the stop would show up here as
    // live-state and server calls, whenever the socket gets to it.
    await settle(80)
    expect(r.log).toHaveLength(1)
    expect(r.server.calls).toEqual([])
    expect(r.headless.getLiveProgress().connected).toBe(false)
    expect(await r.headless.resolveConditionAction({ kind: 'custom', id: 'x', label: 'x', name: 'opencode.permission.reply', payload: { requestID: 'per_1', reply: 'once' } })).toEqual({ ok: false, reason: 'no-live-channel' })
    await r.headless.stop()
  })

  it('a stop() right after start(), before the server answers, silences everything', async () => {
    // Timers: see the note in the test above and the fake-timer count in
    // OpencodeTerminalHeadless.startup.test.ts.
    const r = await rig(loadLiveFixture('plain.json'))
    await r.headless.start()
    await r.headless.stop()
    // The one /event request already on the wire is aborted; nothing follows it.
    await settle(80)
    expect(r.log.filter(e => e.kind === 'live-state')).toEqual([])
    expect(r.server.calls.filter(c => c.path !== '/event')).toEqual([])
    expect(r.server.calls.filter(c => c.path === '/event').length).toBeLessThanOrEqual(1)
    expect(r.server.openStreamCount()).toBe(0)
    expect(await r.headless.resolveConditionAction({ kind: 'custom', id: 'x', label: 'x', name: 'opencode.question.reject', payload: { questionID: 'que_1' } })).toEqual({ ok: false, reason: 'no-live-channel' })
    await r.headless.stop()
  })

  // A PTY that reports its exit synchronously from inside onExit() is covered
  // in OpencodeTerminalHeadless.startup.test.ts, where the fetch, the store
  // and the timers are all counted exactly.

  it('writes prompts to the caller-owned PTY as one bracketed paste and forwards resizes', async () => {
    const r = await rig(loadLiveFixture('plain.json'))
    await r.headless.start()
    r.headless.pasteAndSubmit('line one\nline two')
    r.headless.resize(100, 30)
    expect(r.pty.writes).toEqual(['\x1b[200~line one\nline two\x1b[201~\r'])
    expect(r.pty.sizes).toEqual([[100, 30]])
  })
})
