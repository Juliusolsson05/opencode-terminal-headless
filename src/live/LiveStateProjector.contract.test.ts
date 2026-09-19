import { describe, expect, it } from 'vitest'

import { LiveStateProjector } from './LiveStateProjector.js'
import type { LiveBusEvent, LiveOutput } from './types.js'

// Behaviour no Stage 0 recording contains (retry, errors, compaction after an
// overflow, session navigation, re-sync races), pinned by hand-authored event
// sequences. Each shape is the upstream 1.18.30 wire shape, cited per test and
// checked against the installed binary; the expected outputs are what that
// upstream code does, written out by hand — never read off the projector.

const A = 'ses_bound'

const status = (sessionID: string, type: string, extra: Record<string, unknown> = {}): LiveBusEvent => ({ type: 'session.status', properties: { sessionID, status: { type, ...extra } } })
const idle = (sessionID: string): LiveBusEvent => ({ type: 'session.idle', properties: { sessionID } })
const textPart = (sessionID: string, messageID: string, id: string): LiveBusEvent => ({ type: 'message.part.updated', properties: { sessionID, part: { id, messageID, sessionID, type: 'text', text: '…' } } })
const assistant = (sessionID: string, id: string): LiveBusEvent => ({ type: 'message.updated', properties: { sessionID, info: { id, sessionID, role: 'assistant', parentID: 'msg_u' } } })
const user = (sessionID: string, id: string): LiveBusEvent => ({ type: 'message.updated', properties: { sessionID, info: { id, sessionID, role: 'user', time: { created: 1 } } } })
const created = (id: string, parentID?: string): LiveBusEvent => ({ type: 'session.created', properties: { sessionID: id, info: { id, ...(parentID ? { parentID } : {}), title: 't' } } })
const sessionError = (sessionID: string, error: Record<string, unknown>): LiveBusEvent => ({ type: 'session.error', properties: { sessionID, error } })

function run(projector: LiveStateProjector, events: LiveBusEvent[]): LiveOutput[] {
  return events.flatMap(event => projector.apply(event))
}

const labels = (outputs: LiveOutput[]) => outputs.filter((o): o is Extract<LiveOutput, { kind: 'activity' }> => o.kind === 'activity').map(o => o.status)
const count = (outputs: LiveOutput[], kind: LiveOutput['kind']) => outputs.filter(o => o.kind === kind).length

describe('retry status (sst/opencode@v1.18.30 packages/opencode/src/session/status.ts `retry`)', () => {
  it('labels the retry, and restores the ordinary label when busy resumes in the same phase', () => {
    // SessionProcessor sets `retry` while waiting, then `busy` again when the
    // retried request's stream starts; the text resumes in the phase it was in.
    const projector = new LiveStateProjector(A, { now: () => 1 })
    const outputs = run(projector, [
      status(A, 'busy'),
      assistant(A, 'msg_a'),
      textPart(A, 'msg_a', 'prt_1'),
      status(A, 'retry', { attempt: 1, message: 'rate limited', next: 2000 }),
      status(A, 'busy'),
      textPart(A, 'msg_a', 'prt_1'),
      idle(A),
    ])
    expect(labels(outputs)).toEqual(['requesting', 'responding', 'retrying (attempt 1)', 'responding', null])
    expect(count(outputs, 'turn-start')).toBe(1)
    expect(count(outputs, 'turn-end')).toBe(1)
  })

  it('does the same when the retry interrupted a tool call', () => {
    const projector = new LiveStateProjector(A, { now: () => 1 })
    const running: LiveBusEvent = { type: 'message.part.updated', properties: { sessionID: A, part: { id: 'prt_t', messageID: 'msg_a', sessionID: A, type: 'tool', tool: 'bash', state: { status: 'running' } } } }
    const outputs = run(projector, [status(A, 'busy'), running, status(A, 'retry', { attempt: 2, message: 'overloaded', next: 4000 }), status(A, 'busy'), running, status(A, 'idle')])
    expect(labels(outputs)).toEqual(['requesting', 'running bash', 'retrying (attempt 2)', 'running bash', null])
    expect(count(outputs, 'turn-start')).toBe(1)
  })

  it('stays silent on repeated busy without a retry', () => {
    const projector = new LiveStateProjector(A)
    run(projector, [status(A, 'busy')])
    expect(projector.apply(status(A, 'busy'))).toEqual([])
  })
})

describe('session.error (sst/opencode@v1.18.30 packages/opencode/src/session/processor.ts `halt`)', () => {
  it('reports error.data.message, the NamedError wire shape, with the open turn', () => {
    const projector = new LiveStateProjector(A, { now: () => 1 })
    const [start] = projector.apply(status(A, 'busy')) as Array<Extract<LiveOutput, { kind: 'turn-start' }>>
    const outputs = projector.apply(sessionError(A, { name: 'APIError', data: { message: 'rate limited', statusCode: 429, isRetryable: false } }))
    expect(outputs).toEqual([{ kind: 'api-error', message: 'rate limited', turnId: start!.turnId, errorType: 'APIError' }])
  })

  it('falls back to error.message, then to the error name, as the binary formats errors', () => {
    const projector = new LiveStateProjector(A)
    expect(projector.apply(sessionError(A, { message: 'plain message' }))).toEqual([{ kind: 'api-error', message: 'plain message', turnId: null }])
    // MessageOutputLengthError carries `data: {}`: its name is all there is.
    expect(projector.apply(sessionError(A, { name: 'MessageOutputLengthError', data: {} }))).toEqual([{ kind: 'api-error', message: 'MessageOutputLengthError', turnId: null, errorType: 'MessageOutputLengthError' }])
    // Nothing usable at all still reports an error rather than dropping it.
    expect(projector.apply(sessionError(A, {}))).toEqual([{ kind: 'api-error', message: 'OpenCode session error', turnId: null }])
  })

  it('names a user abort MessageAbortedError, from the recorded database row (Agent Code #1018 catalog case b)', () => {
    // OpenCode 1.18.31 wrote this error on the assistant row when the user
    // pressed Esc mid-turn; session.error carries the same object. It is an
    // interruption, and the name is how a consumer knows that.
    const projector = new LiveStateProjector(A)
    expect(projector.apply(sessionError(A, { name: 'MessageAbortedError', data: { message: 'Aborted' } })))
      .toEqual([{ kind: 'api-error', message: 'Aborted', turnId: null, errorType: 'MessageAbortedError' }])
  })

  it('does not end the turn itself; the idle that the processor publishes next does', () => {
    const projector = new LiveStateProjector(A)
    const outputs = run(projector, [status(A, 'busy'), sessionError(A, { name: 'APIError', data: { message: 'boom' } })])
    expect(count(outputs, 'turn-end')).toBe(0)
    expect(projector.isBusy()).toBe(true)
    const ending = run(projector, [status(A, 'idle'), idle(A)])
    expect(ending.map(o => o.kind)).toEqual(['durable-hint', 'turn-end', 'phase', 'activity'])
  })

  it('keeps one turn when a context overflow continues into compaction', () => {
    // halt(): ContextOverflowError with auto-compaction sets needsCompaction,
    // publishes the error and returns WITHOUT idle; the loop compacts inside
    // the same busy span and only then goes idle.
    const projector = new LiveStateProjector(A)
    const outputs = run(projector, [
      status(A, 'busy'),
      assistant(A, 'msg_a'),
      textPart(A, 'msg_a', 'prt_1'),
      sessionError(A, { name: 'ContextOverflowError', data: { message: 'prompt is too long' } }),
      status(A, 'busy'),
      assistant(A, 'msg_summary'),
      textPart(A, 'msg_summary', 'prt_2'),
      status(A, 'idle'),
      idle(A),
    ])
    expect(count(outputs, 'turn-start')).toBe(1)
    expect(count(outputs, 'turn-end')).toBe(1)
    expect(outputs.find(o => o.kind === 'api-error')).toMatchObject({ message: 'prompt is too long' })
    // Nothing reported the pane idle before the compaction finished.
    const inactive = outputs.findIndex(o => o.kind === 'activity' && !o.active)
    expect(inactive).toBe(outputs.length - 1)
  })
})

describe('question answered in the TUI (sst/opencode@v1.18.30 packages/opencode/src/question/index.ts `Replied`)', () => {
  it('clears the question like a rejection', () => {
    const projector = new LiveStateProjector(A)
    const asked = projector.apply({ type: 'question.asked', properties: { id: 'que_1', sessionID: A, questions: [{ question: 'Red or blue?', options: [] }] } })
    expect((asked[0] as Extract<LiveOutput, { kind: 'requests' }>).question?.questionID).toBe('que_1')
    expect(projector.apply({ type: 'question.replied', properties: { sessionID: A, requestID: 'que_1', answers: [['Red']] } })).toEqual([{ kind: 'requests', permission: null, question: null }])
  })
})

describe('re-sync fencing per entity, and reply tombstones', () => {
  const permission = (id: string, sessionID = A) => ({ id, sessionID, permission: 'bash', patterns: ['ls'] })

  it('drops what the server no longer lists, skips only the id the stream restated, restores the rest', () => {
    const projector = new LiveStateProjector(A)
    run(projector, [{ type: 'permission.asked', properties: permission('per_gone') }])
    const since = projector.revision()
    // Replied on the stream after the read was sent; the snapshot still lists it.
    run(projector, [{ type: 'permission.replied', properties: { sessionID: A, requestID: 'per_replied', reply: 'once' } }])
    projector.resync({ permissions: [permission('per_replied'), permission('per_new')] }, since)
    // per_gone: answered while disconnected → removed. per_replied: not
    // revived. per_new: unaffected → restored.
    expect(projector.currentRequests().permission?.requestID).toBe('per_new')
    expect(projector.forgetRequest('permission', 'per_gone')).toEqual([])
    expect(projector.forgetRequest('permission', 'per_replied')).toEqual([])
  })

  it('takes only its own and its descendants\' requests from a snapshot', () => {
    const projector = new LiveStateProjector(A)
    run(projector, [created('ses_child', A)])
    projector.resync({ permissions: [permission('per_other', 'ses_other'), permission('per_child', 'ses_child')] })
    expect(projector.currentRequests().permission?.requestID).toBe('per_child')
  })

  it('applies the owned status from a snapshot even when another session changed status meanwhile', () => {
    const projector = new LiveStateProjector(A)
    run(projector, [status(A, 'busy')])
    const since = projector.revision()
    run(projector, [status('ses_other', 'busy')])
    const outputs = projector.resync({ status: {} }, since)
    expect(outputs.map(o => o.kind)).toEqual(['durable-hint', 'turn-end', 'phase', 'activity'])
  })

  it('skips only the snapshot entity the stream restated after the request was sent', () => {
    const projector = new LiveStateProjector(A)
    run(projector, [status(A, 'busy')])
    const since = projector.revision()
    // Idle arrives on the stream after the read was sent; the snapshot still
    // says busy. The status is newer on the stream and must not re-open.
    run(projector, [idle(A)])
    expect(projector.statusChangedSince(since)).toBe(true)
    projector.resync({ status: { [A]: { type: 'busy' } }, permissions: [permission('per_1')] }, since)
    expect(projector.isBusy()).toBe(false)
    expect(projector.currentRequests().permission?.requestID).toBe('per_1')
  })

  it('never resurrects a locally answered request, from a snapshot or a late redelivery', () => {
    const projector = new LiveStateProjector(A)
    run(projector, [{ type: 'permission.asked', properties: permission('per_1') }])
    const since = projector.revision()
    expect(projector.forgetRequest('permission', 'per_1')).toEqual([{ kind: 'requests', permission: null, question: null }])
    expect(projector.resync({ permissions: [permission('per_1')] }, since)).toEqual([])
    expect(projector.resync({ permissions: [permission('per_1')] })).toEqual([])
    expect(projector.apply({ type: 'permission.asked', properties: permission('per_1') })).toEqual([])
    // The bus confirmation that follows is a no-op, not a second clear.
    expect(projector.apply({ type: 'permission.replied', properties: { sessionID: A, requestID: 'per_1', reply: 'once' } })).toEqual([])
    expect(projector.currentRequests().permission).toBeNull()
  })
})

describe('session-switch detection (detection only)', () => {
  it('reports /new then a prompt: a new root session, created on submit, gets its first user message', () => {
    // component/prompt/index.tsx creates the session when the first prompt of
    // a /new route is submitted, then posts the prompt.
    const projector = new LiveStateProjector(A)
    run(projector, [status(A, 'busy'), user(A, 'msg_a1'), idle(A)])
    const outputs = run(projector, [created('ses_new'), user('ses_new', 'msg_b1'), status('ses_new', 'busy')])
    expect(outputs.filter(o => o.kind === 'session-switched')).toEqual([{ kind: 'session-switched', from: A, to: 'ses_new' }])
    // Detection only: the projector still observes the launch session.
    expect(outputs.filter(o => o.kind !== 'session-switched')).toEqual([])
  })

  it('ignores a task child\'s prompt, announced or found through the store', () => {
    // tool/task.ts creates children with `parentID`.
    const announced = new LiveStateProjector(A)
    expect(run(announced, [created('ses_child', A), user('ses_child', 'msg_c1')]).filter(o => o.kind === 'session-switched')).toEqual([])
    // A grandchild's neither.
    expect(run(announced, [created('ses_grandchild', 'ses_child'), user('ses_grandchild', 'msg_g1')]).filter(o => o.kind === 'session-switched')).toEqual([])
    const looked = new LiveStateProjector(A, { parentOf: id => (id === 'ses_child' ? A : undefined) })
    expect(run(looked, [user('ses_child', 'msg_c1')]).filter(o => o.kind === 'session-switched')).toEqual([])
  })

  // The three cases below are the reconnect boundary. Switch detection reads a
  // busy map that ONLY bus events used to write, so across a disconnect it kept
  // describing the world as it was before the outage. Existing switch tests all
  // deliver the relevant busy/idle directly on the stream, so none of them can
  // reach this.
  it('reports a switch to a root that went idle while we were disconnected', () => {
    const projector = new LiveStateProjector(A, { parentOf: id => (id === 'ses_b' ? null : undefined) })
    // B is busy in the background before the outage: its automatic messages are
    // correctly ignored as someone else's work.
    run(projector, [status('ses_b', 'busy')])
    const since = projector.revision()
    // While disconnected B finished. The snapshot lists only non-idle sessions,
    // so B's absence IS the statement that it is idle.
    projector.resync({ status: {} }, since)
    // The user then chooses B in the TUI and prompts it. Before the fix the
    // stale "B is busy" entry swallowed this as background noise, and the pane
    // silently kept following A while the TUI drove B.
    expect(run(projector, [user('ses_b', 'msg_b1')]).filter(o => o.kind === 'session-switched'))
      .toEqual([{ kind: 'session-switched', from: A, to: 'ses_b' }])
  })

  it('does not invent a switch for a root that went busy while we were disconnected', () => {
    const projector = new LiveStateProjector(A, { parentOf: id => (id === 'ses_b' ? null : undefined) })
    const since = projector.revision()
    projector.resync({ status: { ses_b: { type: 'busy' } } }, since)
    // An automatic message inside B's own running turn (compaction, a summary
    // rewrite) is not the user navigating. Before the fix the map had never
    // learned B was busy, so this raised a false switch — which the host turns
    // into a persistent pane error accusing the user of something they did not do.
    expect(run(projector, [user('ses_b', 'msg_auto')]).filter(o => o.kind === 'session-switched')).toEqual([])
  })

  it('keeps a status the stream restated while the snapshot was in flight', () => {
    const projector = new LiveStateProjector(A, { parentOf: id => (id === 'ses_b' ? null : undefined) })
    const since = projector.revision()
    // The snapshot was requested, then the bus said B is busy before it landed.
    run(projector, [status('ses_b', 'busy')])
    // A snapshot captured BEFORE that event must not undo it, or the race
    // reintroduces the false switch the previous case protects against.
    projector.resync({ status: {} }, since)
    expect(run(projector, [user('ses_b', 'msg_auto')]).filter(o => o.kind === 'session-switched')).toEqual([])
  })

  it('does not guess when a session\'s parentage is unknown', () => {
    const projector = new LiveStateProjector(A, { parentOf: () => undefined })
    expect(run(projector, [user('ses_unknown', 'msg_x')])).toEqual([])
  })

  it('reports a session chosen from /sessions (found as a root in the store), and a later switch back', () => {
    const projector = new LiveStateProjector(A, { parentOf: id => (id === 'ses_old' ? null : undefined) })
    const toOld = run(projector, [user('ses_old', 'msg_o1')])
    expect(toOld).toEqual([{ kind: 'session-switched', from: A, to: 'ses_old' }])
    const back = run(projector, [user(A, 'msg_a2')])
    expect(back.filter(o => o.kind === 'session-switched')).toEqual([{ kind: 'session-switched', from: 'ses_old', to: A }])
  })

  it('stays quiet about background events of the bound session after a switch', () => {
    const projector = new LiveStateProjector(A)
    run(projector, [user(A, 'msg_a1'), status(A, 'busy')])
    expect(run(projector, [created('ses_new'), user('ses_new', 'msg_b1')]).filter(o => o.kind === 'session-switched')).toHaveLength(1)
    const background = run(projector, [
      // A keeps running: its assistant, parts, a compaction's automatic user
      // message (session/compaction.ts writes those inside the busy span)…
      assistant(A, 'msg_a_ans'),
      textPart(A, 'msg_a_ans', 'prt_9'),
      user(A, 'msg_a_compaction_replay'),
      // …and after its idle, the summary rewrite of the prompt already seen.
      status(A, 'idle'),
      idle(A),
      user(A, 'msg_a1'),
    ])
    expect(background.filter(o => o.kind === 'session-switched')).toEqual([])
  })

  it('does not count an automatic message in another busy root session, but does count a prompt there once it idles', () => {
    const projector = new LiveStateProjector(A)
    run(projector, [created('ses_bg'), status('ses_bg', 'busy')])
    expect(run(projector, [user('ses_bg', 'msg_bg_auto')])).toEqual([])
    run(projector, [status('ses_bg', 'idle')])
    expect(run(projector, [user('ses_bg', 'msg_bg_prompt')])).toEqual([{ kind: 'session-switched', from: A, to: 'ses_bg' }])
  })
})
