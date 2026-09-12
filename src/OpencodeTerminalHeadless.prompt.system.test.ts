import { describe, expect, it } from 'vitest'

import { startConnected, useReplayRigs } from './testing/e2eRig.js'
import { loadLiveFixture } from './testing/fixtures.js'
import { waitUntil } from './testing/replay.js'

// The server's recorded request is the oracle, not a client-side builder.
// Installed 1.18.30's prompt_async path owns sessionID in the URL; the body
// carries the text parts AND the session's agent/model/variant, and a bodyless
// 204 acknowledges acceptance.
const { rig } = useReplayRigs()
const recording = loadLiveFixture('plain.json')
const promptPath = `/session/${recording.sessionID}/prompt_async`

describe('OpencodeTerminalHeadless.submitPrompt', () => {
  it('carries the session\u2019s own agent, model and variant, and never pastes', async () => {
    // WHY a non-default agent is the only honest fixture here: omitting `agent`
    // makes 1.18.30 resolve `Agent.defaultInfo()` — normally `build` — and then
    // PERSIST it over the user's choice via `Session.setAgentModel`. A session
    // already on `build` would pass whether or not we sent anything, so it
    // could never have caught this. One of our own recorded sessions
    // (ses_f963831c3ffe…) really is on `general`, which is what this imitates.
    const r = await rig(recording, {
      sessionRow: {
        agent: 'plan',
        model: JSON.stringify({ id: 'claude-sonnet-4-5', providerID: 'anthropic', variant: 'high' }),
      },
    })
    await startConnected(r)
    const text = 'Explain this repository.\nKeep the 项目 name and %20 literal.'
    expect(await r.headless.submitPrompt(text)).toEqual({ ok: true })
    expect(r.server.calls.filter(call => call.method === 'POST')).toEqual([{
      method: 'POST', path: promptPath,
      body: JSON.stringify({
        parts: [{ type: 'text', text }],
        agent: 'plan',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
        variant: 'high',
      }),
      authorized: true,
    }])
    expect(r.pty.writes).toEqual([])
  })

  it('omits what the session never chose, and never forwards the "default" variant sentinel', async () => {
    // `setAgentModel` writes `variant ?? "default"`, so "default" means "no
    // variant". Forwarding it literally would pin the turn to a variant by
    // that name and suppress the agent's configured one — the same class of
    // silent override this whole fix exists to prevent, one level down.
    const r = await rig(recording, {
      sessionRow: { agent: null, model: JSON.stringify({ id: 'gpt-5', providerID: 'openai', variant: 'default' }) },
    })
    await startConnected(r)
    expect(await r.headless.submitPrompt('hello')).toEqual({ ok: true })
    expect(JSON.parse(r.server.calls.find(call => call.method === 'POST')!.body!)).toEqual({
      parts: [{ type: 'text', text: 'hello' }],
      model: { providerID: 'openai', modelID: 'gpt-5' },
    })
  })

  it('still delivers when the session row records no selection at all', async () => {
    // A brand-new session has chosen nothing, and the server's default IS the
    // right answer then. Reading the selection must not make delivery
    // conditional on having one.
    const r = await rig(recording, { sessionRow: { agent: null, model: null } })
    await startConnected(r)
    expect(await r.headless.submitPrompt('hello')).toEqual({ ok: true })
    expect(JSON.parse(r.server.calls.find(call => call.method === 'POST')!.body!)).toEqual({
      parts: [{ type: 'text', text: 'hello' }],
    })
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

  // The next two cases are the reason `unknown` exists as a separate reason.
  // Both wait for `held.arrived`, so the server HAS the prompt body; 1.18.30's
  // route forks the prompt work before it answers, so a lost or absent
  // acknowledgement cannot distinguish "never ran" from "already running".
  // Calling either one `unreachable` told the host it was safe to retry, which
  // is how a user's prompt could be submitted twice.
  it('reports a connection lost after the server received the POST as unknown, without submitting a second time', async () => {
    const r = await rig(recording)
    await startConnected(r)
    const held = r.server.holdNext(promptPath)
    const delivery = r.headless.submitPrompt('lost acknowledgement', { timeoutMs: 1000 })
    try {
      await held.arrived
      await r.server.close()
      expect(await delivery).toMatchObject({ ok: false, reason: 'unknown' })
      expect(r.server.calls.filter(call => call.path === promptPath)).toHaveLength(1)
      expect(r.pty.writes).toEqual([])
    } finally {
      held.release()
      await delivery
    }
  })

  it('bounds a POST that never answers by the prompt deadline, and reports it as unknown', async () => {
    const r = await rig(recording)
    await startConnected(r)
    const held = r.server.holdNext(promptPath)
    const delivery = r.headless.submitPrompt('hung acknowledgement', { timeoutMs: 80 })
    try {
      await held.arrived
      expect(await delivery).toMatchObject({ ok: false, reason: 'unknown' })
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
