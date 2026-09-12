import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OpencodeTerminalLaunch } from './launch/prepareLaunch.js'
import { OpencodeTerminalHeadless, type OpencodeTerminalHeadlessEvents } from './OpencodeTerminalHeadless.js'
import type { PtyExitEvent, PtyLike } from './terminal/PtyBinding.js'
import { FakePty } from './testing/replay.js'

// start() against host code that stops or exits the instance from inside a
// startup callback (R2-F4), with every clock and socket under the test's
// control: fake timers make "no timers left" an exact count
// (`vi.getTimerCount()`, which sees unref'd timers — unlike
// process.getActiveResourcesInfo(), which does not), and a fetch that never
// answers stands in for a server that has not come up yet. The expectations
// are hand-authored: after a stop or exit, nothing.

afterEach(() => {
  vi.useRealTimers()
})

const launch = (dbPath: string | null): OpencodeTerminalLaunch => ({
  binary: 'opencode',
  args: [],
  env: {},
  sessionID: 'ses_startup',
  server: { url: 'http://127.0.0.1:9', username: 'opencode', password: 'pw' },
  dbPath,
})

/** A fetch that records calls and never answers until aborted. */
function silentServer(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    calls.push(String(input))
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

const EVENTS: Array<keyof OpencodeTerminalHeadlessEvents> = ['activity', 'entry', 'semantic', 'conditions', 'transcript-error', 'live-state', 'session-switched', 'exit']

function record(headless: OpencodeTerminalHeadless): string[] {
  const seen: string[] = []
  for (const name of EVENTS) headless.on(name, () => seen.push(name))
  return seen
}

describe('OpencodeTerminalHeadless start() fencing', () => {
  it('stops cleanly when a transcript-error handler stops it mid-start: no later events, no HTTP, no timers', async () => {
    vi.useFakeTimers()
    const server = silentServer()
    const headless = new OpencodeTerminalHeadless({ pty: new FakePty(), cwd: '/p', launch: launch(null), fetch: server.fetch })
    const seen = record(headless)
    headless.on('transcript-error', () => { void headless.stop() })
    await headless.start()
    expect(seen).toEqual(['transcript-error'])
    expect(server.calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    // Past every deadline and backoff the instance could have armed.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(seen).toEqual(['transcript-error'])
    expect(server.calls).toEqual([])
    // A second stop is a safe no-op.
    await headless.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles a PTY that reports its exit while being subscribed: exit once, no store open, no HTTP, no timers', async () => {
    vi.useFakeTimers()
    const server = silentServer()
    let opens = 0
    const pty: PtyLike = {
      pid: 1,
      write() {},
      resize() {},
      onExit(listener: (event: PtyExitEvent) => void) {
        listener({ exitCode: 7 })
        return { dispose() {} }
      },
    }
    const headless = new OpencodeTerminalHeadless({
      pty,
      cwd: '/p',
      launch: launch('/never/opened.db'),
      fetch: server.fetch,
      openStore: () => {
        opens += 1
        throw new Error('the store must not be opened after the TUI exited')
      },
    })
    const seen = record(headless)
    const exits: Array<OpencodeTerminalHeadlessEvents['exit'][0]> = []
    headless.on('exit', event => exits.push(event))
    expect(headless.isExited()).toBe(true)
    await headless.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(seen).toEqual(['exit'])
    expect(exits).toEqual([{ exitCode: 7 }])
    expect(opens).toBe(0)
    expect(server.calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    await headless.stop()
  })

  it('a stop() right after start(), while the server has not answered, leaves nothing running', async () => {
    vi.useFakeTimers()
    const server = silentServer()
    // No database: the durable channel reports itself off at start (one
    // transcript-error), so the live channel is the only thing running.
    const headless = new OpencodeTerminalHeadless({ pty: new FakePty(), cwd: '/p', launch: launch(null), fetch: server.fetch })
    const seen = record(headless)
    await headless.start()
    expect(seen).toEqual(['transcript-error', 'conditions'])
    // The event stream request is on the wire and the connect deadline armed.
    expect(server.calls).toEqual(['http://127.0.0.1:9/event'])
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    const beforeStop = [...seen]
    await headless.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(seen).toEqual(beforeStop)
    expect(seen).not.toContain('live-state')
    expect(server.calls).toHaveLength(1)
    expect(await headless.resolveConditionAction({ kind: 'custom', id: 'x', label: 'x', name: 'opencode.question.reject', payload: { questionID: 'que_1' } })).toEqual({ ok: false, reason: 'no-live-channel' })
  })
})
