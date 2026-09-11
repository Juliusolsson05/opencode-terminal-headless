import { describe, expect, it } from 'vitest'

import type { ConditionSnapshot } from './conditions/core/contract.js'
import { useReplayRigs, startConnected, type LogEntry, type Rig } from './testing/e2eRig.js'
import { loadLiveFixture, type LiveFixture } from './testing/fixtures.js'
import { buildReplayScript, playReplay, settle, type ReplayStep } from './testing/replay.js'

// Answering permission and question prompts through the TUI's own server,
// as Agent Code's condition actions do.
//
// Every expectation is derived from the recording itself (its status spans,
// its durable rows, its request ids), never from the code under test. The
// rig and oracles are shared in src/testing/e2eRig.ts.

const { rig } = useReplayRigs()

describe('OpencodeTerminalHeadless answering conditions through the TUI server', () => {
  async function pauseAt(recording: LiveFixture, type: string, onPause: (r: Rig) => Promise<void>): Promise<Rig> {
    const r = await rig(recording)
    await startConnected(r)
    let paused = false
    await playReplay(buildReplayScript(recording), r.writer, r.server, {
      beforeStep: async (step: ReplayStep) => {
        if (!paused && step.kind === 'sse' && step.event.type === type) {
          paused = true
          await settle(30)
          await onPause(r)
        }
      },
    })
    return r
  }

  function latestConditions(r: Rig): ConditionSnapshot<'opencode'> {
    return [...r.log].reverse().find((e): e is Extract<LogEntry, { kind: 'conditions' }> => e.kind === 'conditions')!.snapshot
  }

  it('replies "once" to a recorded permission, clearing the badge before the bus confirms', async () => {
    const recording = loadLiveFixture('permission-once.json')
    const asked = recording.sse.find(({ event }) => event.type === 'permission.asked')!.event
    let conditionsAfterReply = -1
    const r = await pauseAt(recording, 'permission.replied', async paused => {
      const record = latestConditions(paused).conditions['opencode.permission']!
      const once = record.actions.find(action => action.label === 'Allow once')!
      expect(once.kind).toBe('custom')
      const result = await paused.headless.resolveConditionAction(once as Extract<typeof once, { kind: 'custom' }>)
      expect(result).toEqual({ ok: true })
      expect(latestConditions(paused).conditions).toEqual({})
      conditionsAfterReply = paused.log.filter(e => e.kind === 'conditions').length
    })
    const post = r.server.calls.filter(c => c.method === 'POST')
    expect(post).toEqual([{ method: 'POST', path: `/permission/${asked.properties!.id}/reply`, body: '{"reply":"once"}', authorized: true }])
    // The recorded permission.replied that followed changed nothing further.
    expect(r.log.filter(e => e.kind === 'conditions').length).toBe(conditionsAfterReply)
  })

  it('maps the Reject action to the recorded reject reply', async () => {
    const recording = loadLiveFixture('permission-reject.json')
    const r = await pauseAt(recording, 'permission.replied', async paused => {
      const reject = latestConditions(paused).conditions['opencode.permission']!.actions.find(action => action.label === 'Reject')!
      expect(await paused.headless.resolveConditionAction(reject as Extract<typeof reject, { kind: 'custom' }>)).toEqual({ ok: true })
    })
    expect(r.server.calls.find(c => c.method === 'POST')?.body).toBe('{"reply":"reject"}')
  })

  it('rejects a recorded question', async () => {
    const recording = loadLiveFixture('question-reject.json')
    const asked = recording.sse.find(({ event }) => event.type === 'question.asked')!.event
    const r = await pauseAt(recording, 'question.rejected', async paused => {
      const reject = latestConditions(paused).conditions['opencode.question']!.actions[0]!
      expect(await paused.headless.resolveConditionAction(reject as Extract<typeof reject, { kind: 'custom' }>)).toEqual({ ok: true })
      expect(latestConditions(paused).conditions).toEqual({})
    })
    expect(r.server.calls.find(c => c.method === 'POST')?.path).toBe(`/question/${asked.properties!.id}/reject`)
  })

  it('refuses malformed and unknown actions without calling the server', async () => {
    const r = await rig(loadLiveFixture('plain.json'))
    await startConnected(r)
    expect(await r.headless.resolveConditionAction({ kind: 'custom', id: 'x', label: 'x', name: 'opencode.permission.reply', payload: { requestID: 'per_1', reply: 'maybe' } })).toEqual({ ok: false, reason: 'invalid-payload' })
    expect(await r.headless.resolveConditionAction({ kind: 'custom', id: 'x', label: 'x', name: 'claude.trust-dialog.accept' })).toEqual({ ok: false, reason: 'no-resolver' })
    expect(r.server.calls.filter(c => c.method === 'POST')).toEqual([])
  })
})
