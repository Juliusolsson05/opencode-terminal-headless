import { describe, expect, it } from 'vitest'

import { FakePty } from '../testing/replay.js'
import { PtyBinding, type PtyExitEvent, type PtyLike } from './PtyBinding.js'

// The binding's contract with a caller-owned PTY, hand-authored from the
// structural node-pty surface it accepts (`onExit` returns a disposable; an
// exit is reported once): exits are never lost, never doubled, and never keep
// the owner alive after the process is gone.

/** A PTY that already exited and reports it synchronously from `onExit()`. */
function alreadyExitedPty(event: PtyExitEvent): PtyLike & { disposed: number } {
  const pty = {
    pid: 7,
    disposed: 0,
    write() {},
    resize() {},
    onExit(listener: (event: PtyExitEvent) => void) {
      listener(event)
      return { dispose: () => { pty.disposed += 1 } }
    },
  }
  return pty
}

describe('PtyBinding', () => {
  it('latches an exit that happens before the owner subscribes, and delivers it once on subscription', () => {
    const pty = new FakePty()
    const binding = new PtyBinding(pty)
    pty.exit(12)
    expect(binding.isExited()).toBe(true)
    const seen: PtyExitEvent[] = []
    binding.onExit(event => seen.push(event))
    expect(seen).toEqual([{ exitCode: 12, signal: undefined }])
    binding.onExit(event => seen.push(event))
    expect(seen).toHaveLength(1)
  })

  it('handles a PTY that reports its exit synchronously from inside onExit()', () => {
    const pty = alreadyExitedPty({ exitCode: 7 })
    const binding = new PtyBinding(pty)
    // The subscription handed back after the synchronous callback is released
    // at once: there is nothing left to hear.
    expect(pty.disposed).toBe(1)
    expect(binding.isSubscribed()).toBe(false)
    const seen: PtyExitEvent[] = []
    binding.onExit(event => seen.push(event))
    expect(seen).toEqual([{ exitCode: 7 }])
  })

  it('delivers a later exit exactly once, ignoring a second report from the PTY', () => {
    const pty = new FakePty()
    const binding = new PtyBinding(pty)
    const seen: PtyExitEvent[] = []
    binding.onExit(event => seen.push(event))
    pty.exit(0, 15)
    pty.exit(1)
    expect(seen).toEqual([{ exitCode: 0, signal: 15 }])
  })

  it('releases its PTY subscription on a natural exit, without a detach', () => {
    const pty = new FakePty()
    const binding = new PtyBinding(pty)
    binding.onExit(() => {})
    expect(pty.listenerCount()).toBe(1)
    pty.exit(0)
    expect(pty.listenerCount()).toBe(0)
    expect(binding.isSubscribed()).toBe(false)
  })

  it('never delivers after detach, and detach is idempotent', () => {
    const pty = new FakePty()
    const binding = new PtyBinding(pty)
    const seen: PtyExitEvent[] = []
    binding.onExit(event => seen.push(event))
    binding.detach()
    binding.detach()
    expect(pty.listenerCount()).toBe(0)
    pty.exit(3)
    expect(seen).toEqual([])
    // A subscription after detach is refused, even for an exit latched later.
    binding.onExit(event => seen.push(event))
    expect(seen).toEqual([])
  })

  it('drops writes once the process exited, and survives a PTY that throws on resize', () => {
    const pty = new FakePty()
    const binding = new PtyBinding(pty)
    binding.pasteAndSubmit('hi')
    pty.exit(0)
    binding.write('lost')
    expect(pty.writes).toEqual(['\x1b[200~hi\x1b[201~\r'])
    const throwing = { ...alreadyExitedPty({ exitCode: 0 }), resize() { throw new Error('0x0') } }
    expect(() => new PtyBinding(throwing).resize(0, 0)).not.toThrow()
  })
})
