import { describe, expect, it } from 'vitest'

import { startConnected, useReplayRigs } from './testing/e2eRig.js'
import { loadLiveFixture } from './testing/fixtures.js'
import { waitUntil } from './testing/replay.js'

// The server's recorded request is the oracle, not a client-side builder.
// Installed 1.18.30's prompt_async path owns sessionID; the body contains only
// text parts, and a bodyless 204 acknowledges acceptance.
const { rig } = useReplayRigs()
const recording = loadLiveFixture('plain.json')
const promptPath = `/session/${recording.sessionID}/prompt_async`

describe('OpencodeTerminalHeadless.submitPrompt', () => {
  it('posts exactly the text parts to the bound session, keeps model/agent selection upstream, and never pastes', async () => {
    const r = await rig(recording)
    await startConnected(r)
    const text = 'Explain this repository.\nKeep the 项目 name and %20 literal.'
    expect(await r.headless.submitPrompt(text)).toEqual({ ok: true })
    expect(r.server.calls.filter(call => call.method === 'POST')).toEqual([{
      method: 'POST', path: promptPath,
      body: JSON.stringify({ parts: [{ type: 'text', text }] }), authorized: true,
    }])
    expect(r.pty.writes).toEqual([])
  })

  it('waits through a booting server and then a held re-sync before delivering', async () => {
    const postAttempts: string[] = []
    const r = await rig(recording, {
      fetch: (input, init) => {
        // The actual fetch boundary, before socket scheduling: a forbidden
        // early POST may not have reached the server when a held GET arrives.
        // Recording the attempt makes the re-sync assertion deterministic.
        if (init?.method === 'POST') postAttempts.push(String(input))
        return fetch(input, init)
      },
    })
    r.server.setRefusing(true)
    const held = r.server.holdNext('/permission')
    let released = false
    await r.headless.start()
    let completed = false
    const delivery = r.headless.submitPrompt('after boot', { timeoutMs: 3000 }).then(result => {
      completed = true
      return result
    })
    try {
      await waitUntil(() => r.server.calls.some(call => call.path === '/event'), 1000, 'initial refused connection')
      expect(completed).toBe(false)
      expect(postAttempts).toEqual([])
      expect(r.server.calls.filter(call => call.method === 'POST')).toEqual([])
      r.server.setRefusing(false)
      await held.arrived
      // A connection is insufficient: re-sync must restore status and
      // conditions before another prompt may be accepted.
      expect(r.headless.getLiveProgress()).toMatchObject({ connected: true, reconciled: false })
      expect(completed).toBe(false)
      expect(postAttempts).toEqual([])
      expect(r.server.calls.filter(call => call.method === 'POST')).toEqual([])
      held.release()
      released = true
      expect(await delivery).toEqual({ ok: true })
      expect(r.server.calls.filter(call => call.path === promptPath)).toHaveLength(1)
      expect(r.pty.writes).toEqual([])
    } finally {
      if (!released) held.release()
      await r.headless.stop()
      await delivery
    }
  })

  it('uses the connect deadline by default and reports a server that never opens as unreachable', async () => {
    const r = await rig(recording, { deadlineMs: 60 })
    await r.server.close()
    await r.headless.start()
    expect(await r.headless.submitPrompt('unreachable')).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(r.pty.writes).toEqual([])
  })

  it.each([400, 503])('reports HTTP %s as rejected with the status and does not retry or paste', async status => {
    const r = await rig(recording)
    await startConnected(r)
    r.server.setFailing(promptPath, true, status)
    expect(await r.headless.submitPrompt('rejected')).toEqual({
      ok: false, reason: 'rejected', detail: `POST ${promptPath} answered ${status}`,
    })
    expect(r.server.calls.filter(call => call.path === promptPath)).toHaveLength(1)
    expect(r.pty.writes).toEqual([])
  })

  it('reports a connection lost during POST as unreachable, without submitting a second time', async () => {
    const r = await rig(recording)
    await startConnected(r)
    const held = r.server.holdNext(promptPath)
    const delivery = r.headless.submitPrompt('lost acknowledgement', { timeoutMs: 1000 })
    try {
      await held.arrived
      await r.server.close()
      expect(await delivery).toMatchObject({ ok: false, reason: 'unreachable' })
      expect(r.server.calls.filter(call => call.path === promptPath)).toHaveLength(1)
      expect(r.pty.writes).toEqual([])
    } finally {
      held.release()
      await delivery
    }
  })

  it('bounds an accepted connection whose POST never answers by the same prompt deadline', async () => {
    const r = await rig(recording)
    await startConnected(r)
    const held = r.server.holdNext(promptPath)
    const delivery = r.headless.submitPrompt('hung acknowledgement', { timeoutMs: 80 })
    try {
      await held.arrived
      expect(await delivery).toMatchObject({ ok: false, reason: 'unreachable' })
    } finally {
      held.release()
      await delivery
    }
  })

  it('returns no-live-channel before start, after stop, and for a pending wait interrupted by stop', async () => {
    const r = await rig(recording)
    expect(await r.headless.submitPrompt('before start')).toEqual({ ok: false, reason: 'no-live-channel' })
    r.server.setRefusing(true)
    await r.headless.start()
    const delivery = r.headless.submitPrompt('waiting', { timeoutMs: 3000 })
    await waitUntil(() => r.server.calls.some(call => call.path === '/event'), 1000, 'refused connection')
    await r.headless.stop()
    expect(await delivery).toEqual({ ok: false, reason: 'no-live-channel' })
    expect(await r.headless.submitPrompt('after stop')).toEqual({ ok: false, reason: 'no-live-channel' })
    expect(r.server.calls.filter(call => call.method === 'POST')).toEqual([])
    expect(r.pty.writes).toEqual([])
  })
})
