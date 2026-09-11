import { describe, expect, it } from 'vitest'

import type { ConditionCustomAction, ConditionSnapshot } from './conditions/core/contract.js'
import { useReplayRigs, startConnected, replay, type LogEntry, type Rig } from './testing/e2eRig.js'
import { loadLiveFixture, type LiveFixture } from './testing/fixtures.js'
import { buildReplayScript, waitUntil, type ReplayStep } from './testing/replay.js'

// Answering permission and question prompts through the TUI's own server,
// as Agent Code's condition actions do.
//
// Expectations come from the recordings (request ids, endpoint paths, the
// recorded reply values) or, where no recording exists, from the upstream
// 1.18.30 contract named at each test. Never from the code under test. The
// rig and oracles are shared in src/testing/e2eRig.ts.

const { rig } = useReplayRigs()

function latestConditions(r: Rig): ConditionSnapshot<'opencode'> | undefined {
  return [...r.log].reverse().find((e): e is Extract<LogEntry, { kind: 'conditions' }> => e.kind === 'conditions')?.snapshot
}

function action(r: Rig, kind: 'opencode.permission' | 'opencode.question', label: string): ConditionCustomAction {
  const found = latestConditions(r)!.conditions[kind]!.actions.find(candidate => candidate.label === label)!
  expect(found.kind).toBe('custom')
  return found as ConditionCustomAction
}

/**
 * Replay `recording` one event at a time and run `onPause` just before the
 * first bus event of `type` is sent, once the condition of `kind` is visible.
 */
async function pauseAt(recording: LiveFixture, type: string, kind: 'opencode.permission' | 'opencode.question', onPause: (r: Rig) => Promise<void>, script: ReplayStep[] = buildReplayScript(recording)): Promise<Rig> {
  const r = await rig(recording)
  await startConnected(r)
  let paused = false
  await replay(r, script, {
    beforeStep: async (step: ReplayStep) => {
      if (!paused && step.kind === 'sse' && step.event.type === type) {
        paused = true
        await waitUntil(() => latestConditions(r)?.conditions[kind] !== undefined, 3000, `${kind} visible`)
        await onPause(r)
      }
    },
  })
  expect(paused).toBe(true)
  return r
}

describe('OpencodeTerminalHeadless answering conditions through the TUI server', () => {
  it('replies "once" to a recorded permission, clearing the badge before the bus confirms', async () => {
    const recording = loadLiveFixture('permission-once.json')
    const asked = recording.sse.find(({ event }) => event.type === 'permission.asked')!.event
    let conditionsAfterReply = -1
    const r = await pauseAt(recording, 'permission.replied', 'opencode.permission', async paused => {
      const result = await paused.headless.resolveConditionAction(action(paused, 'opencode.permission', 'Allow once'))
      expect(result).toEqual({ ok: true })
      expect(latestConditions(paused)?.conditions).toEqual({})
      conditionsAfterReply = paused.log.filter(e => e.kind === 'conditions').length
    })
    const post = r.server.calls.filter(c => c.method === 'POST')
    expect(post).toEqual([{ method: 'POST', path: `/permission/${asked.properties!.id}/reply`, body: '{"reply":"once"}', authorized: true }])
    // The recorded permission.replied that followed changed nothing further.
    expect(r.log.filter(e => e.kind === 'conditions').length).toBe(conditionsAfterReply)
  })

  it('maps the Reject action to the recorded reject reply', async () => {
    const recording = loadLiveFixture('permission-reject.json')
    const r = await pauseAt(recording, 'permission.replied', 'opencode.permission', async paused => {
      expect(await paused.headless.resolveConditionAction(action(paused, 'opencode.permission', 'Reject'))).toEqual({ ok: true })
    })
    expect(r.server.calls.find(c => c.method === 'POST')?.body).toBe('{"reply":"reject"}')
  })

  it('maps "Allow always" to the upstream "always" reply for the recorded request', async () => {
    // No recording answers "always"; the value is the upstream enum
    // (sst/opencode@v1.18.30 packages/opencode/src/server/routes/instance/
    // permission.ts accepts once | always | reject).
    const recording = loadLiveFixture('permission-once.json')
    const asked = recording.sse.find(({ event }) => event.type === 'permission.asked')!.event
    const r = await pauseAt(recording, 'permission.replied', 'opencode.permission', async paused => {
      expect(await paused.headless.resolveConditionAction(action(paused, 'opencode.permission', 'Allow always'))).toEqual({ ok: true })
      expect(latestConditions(paused)?.conditions).toEqual({})
    })
    expect(r.server.calls.filter(c => c.method === 'POST')).toEqual([
      { method: 'POST', path: `/permission/${asked.properties!.id}/reply`, body: '{"reply":"always"}', authorized: true },
    ])
  })

  it('keeps the condition when the reply fails over HTTP, and a retry then lands', async () => {
    const recording = loadLiveFixture('permission-once.json')
    const asked = recording.sse.find(({ event }) => event.type === 'permission.asked')!.event
    const path = `/permission/${asked.properties!.id}/reply`
    const r = await pauseAt(recording, 'permission.replied', 'opencode.permission', async paused => {
      paused.server.setFailing(path, true)
      const failed = await paused.headless.resolveConditionAction(action(paused, 'opencode.permission', 'Allow once'))
      expect(failed).toMatchObject({ ok: false, reason: 'aborted', failedAtStep: expect.stringContaining('permission.reply') })
      // The user still has something to answer: the badge must not vanish on
      // an answer that never landed.
      expect(paused.headless.getConditionSnapshot().conditions['opencode.permission']?.state).toMatchObject({ requestID: asked.properties!.id })
      paused.server.setFailing(path, false)
      expect(await paused.headless.resolveConditionAction(action(paused, 'opencode.permission', 'Allow once'))).toEqual({ ok: true })
      expect(paused.headless.getConditionSnapshot().conditions).toEqual({})
    })
    expect(r.server.calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual([path, path])
  })

  it('rejects a recorded question', async () => {
    const recording = loadLiveFixture('question-reject.json')
    const asked = recording.sse.find(({ event }) => event.type === 'question.asked')!.event
    const r = await pauseAt(recording, 'question.rejected', 'opencode.question', async paused => {
      expect(await paused.headless.resolveConditionAction(action(paused, 'opencode.question', 'Reject'))).toEqual({ ok: true })
      expect(latestConditions(paused)?.conditions).toEqual({})
    })
    expect(r.server.calls.find(c => c.method === 'POST')?.path).toBe(`/question/${asked.properties!.id}/reject`)
  })

  it('clears a question the user answered in the TUI (question.replied), without posting anything', async () => {
    // Only a reject is recorded. The answer event is the upstream 1.18.30
    // shape `{ sessionID, requestID, answers }` (sst/opencode@v1.18.30
    // packages/opencode/src/question/index.ts `Replied`, present verbatim in
    // the installed binary), substituted for the recorded rejection.
    const recording = loadLiveFixture('question-reject.json')
    const asked = recording.sse.find(({ event }) => event.type === 'question.asked')!.event
    const script = buildReplayScript(recording).map((step): ReplayStep =>
      step.kind === 'sse' && step.event.type === 'question.rejected'
        ? { ...step, event: { type: 'question.replied', properties: { sessionID: recording.sessionID, requestID: asked.properties!.id, answers: [['Yes']] } } }
        : step,
    )
    const r = await pauseAt(recording, 'question.replied', 'opencode.question', async () => {}, script)
    await waitUntil(() => latestConditions(r)?.conditions['opencode.question'] === undefined, 3000, 'question cleared')
    expect(r.headless.getConditionSnapshot().conditions).toEqual({})
    expect(r.server.calls.filter(c => c.method === 'POST')).toEqual([])
  })

  it('refuses malformed and unknown actions without calling the server', async () => {
    const r = await rig(loadLiveFixture('plain.json'))
    await startConnected(r)
    expect(await r.headless.resolveConditionAction({ kind: 'custom', id: 'x', label: 'x', name: 'opencode.permission.reply', payload: { requestID: 'per_1', reply: 'maybe' } })).toEqual({ ok: false, reason: 'invalid-payload' })
    expect(await r.headless.resolveConditionAction({ kind: 'custom', id: 'x', label: 'x', name: 'claude.trust-dialog.accept' })).toEqual({ ok: false, reason: 'no-resolver' })
    expect(r.server.calls.filter(c => c.method === 'POST')).toEqual([])
  })

  it('does not let a re-sync captured before a successful reply bring the request back', async () => {
    // R2-F7: the snapshot below is computed while the permission is still
    // pending on the server, and delivered only after the user's reply was
    // accepted. The reply's own bus event arrives later still.
    const recording = loadLiveFixture('permission-once.json')
    const asked = recording.sse.find(({ event }) => event.type === 'permission.asked')!.event
    const replied = recording.sse.find(({ event }) => event.type === 'permission.replied')!.event
    const script = buildReplayScript(recording)
    const askedAt = script.findIndex(step => step.kind === 'sse' && step.event.type === 'permission.asked')
    const r = await rig(recording)
    await startConnected(r)
    await replay(r, script.slice(0, askedAt + 1))
    await waitUntil(() => latestConditions(r)?.conditions['opencode.permission'] !== undefined, 3000, 'permission visible')

    // A reconnect whose /permission read is held: it captures the request.
    const held = r.server.holdNext('/permission')
    r.server.dropStreams()
    await held.arrived
    const resyncsBefore = r.headless.getLiveProgress().resyncs

    expect(await r.headless.resolveConditionAction(action(r, 'opencode.permission', 'Allow once'))).toEqual({ ok: true })
    expect(r.headless.getConditionSnapshot().conditions).toEqual({})

    held.release()
    await waitUntil(() => r.headless.getLiveProgress().resyncs > resyncsBefore, 3000, 'held re-sync applied')
    expect(r.headless.getConditionSnapshot().conditions).toEqual({})

    // The late bus confirmation is a no-op, not a second clear.
    const conditionsBefore = r.log.filter(e => e.kind === 'conditions').length
    const eventsBefore = r.headless.getLiveProgress().busEvents
    expect(r.server.send(replied)).toBe(1)
    await waitUntil(() => r.headless.getLiveProgress().busEvents > eventsBefore, 3000, 'confirmation applied')
    expect(r.log.filter(e => e.kind === 'conditions').length).toBe(conditionsBefore)
    expect(r.server.calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual([`/permission/${asked.properties!.id}/reply`])
  })
})
