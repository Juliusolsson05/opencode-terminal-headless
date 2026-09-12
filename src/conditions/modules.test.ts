import { describe, expect, it } from 'vitest'

import { permissionFromPayload, questionFromPayload } from '../live/LiveStateProjector.js'
import { loadLiveFixture } from '../testing/fixtures.js'
import { makeEvaluator } from './core/evaluator.js'
import { OPENCODE_TERMINAL_MODULES, PERMISSION_REPLY_ACTION, QUESTION_REJECT_ACTION, type OpencodeConditionInputs } from './modules.js'

// The snapshot these modules produce is a wire contract with Agent Code: the
// renderer's OpenCode condition policy, Dispatch badges and external condition
// control already handle the structured runtime's kinds, state shapes and
// action names. These tests pin that contract using recorded request payloads.

const permissionEvent = loadLiveFixture('permission-once.json').sse.find(({ event }) => event.type === 'permission.asked')!.event
const questionEvent = loadLiveFixture('question-reject.json').sse.find(({ event }) => event.type === 'question.asked')!.event
const permission = permissionFromPayload(permissionEvent.properties!)!
const question = questionFromPayload(questionEvent.properties!)!

function evaluate(inputs: OpencodeConditionInputs) {
  return makeEvaluator('opencode', OPENCODE_TERMINAL_MODULES, () => 7).evaluate(inputs)
}

describe('OpenCode Terminal condition modules', () => {
  it('produce the structured runtime permission record for a recorded request', () => {
    const snapshot = evaluate({ permission, question: null })
    expect(snapshot.provider).toBe('opencode')
    expect(Object.keys(snapshot.conditions)).toEqual(['opencode.permission'])
    const record = snapshot.conditions['opencode.permission']!
    expect(record.state).toEqual({ visible: true, requestID: permissionEvent.properties!.id, title: permission.title, metadata: permissionEvent.properties })
    expect(record.actions.map(action => [action.kind, action.label])).toEqual([
      ['custom', 'Allow once'],
      ['custom', 'Allow always'],
      ['custom', 'Reject'],
    ])
    for (const action of record.actions) {
      expect(action.kind === 'custom' && action.name).toBe(PERMISSION_REPLY_ACTION)
      expect(action.kind === 'custom' && (action.payload as { requestID: string }).requestID).toBe(permissionEvent.properties!.id)
    }
  })

  it('produce a reject-only question record for a recorded question', () => {
    const record = evaluate({ permission: null, question }).conditions['opencode.question']!
    expect(record.state).toMatchObject({ visible: true, questionID: questionEvent.properties!.id })
    expect((record.state as { text: string }).text.length).toBeGreaterThan(0)
    expect(record.actions).toHaveLength(1)
    expect(record.actions[0]).toMatchObject({ kind: 'custom', name: QUESTION_REJECT_ACTION, payload: { questionID: questionEvent.properties!.id } })
  })

  it('order permission before question, which is part of the dedupe key', () => {
    expect(Object.keys(evaluate({ permission, question }).conditions)).toEqual(['opencode.permission', 'opencode.question'])
  })

  it('produce an empty snapshot when nothing is pending', () => {
    expect(evaluate({ permission: null, question: null }).conditions).toEqual({})
  })
})
