import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LiveFixtureWriter } from '../testing/fixtureDatabase.js'
import { sessionRowFor } from '../testing/replay.js'
import { DurableReader, type DurableReaderError } from './DurableReader.js'
import { openOpencodeStore, type OpencodeStore } from './OpencodeStore.js'
import type { OpencodeMessageRecord } from './records.js'

// Write orders no recording contains, hand-authored from OpenCode's source
// and verified against the installed 1.18.30 binary (review R1-F1, probe A):
//
// - `!command` (sst/opencode@v1.18.30 packages/opencode/src/session/prompt.ts,
//   `shellImpl`): user message, its synthetic text part, the assistant, a
//   `running` tool part, output chunks (still `running`), then in `finish`:
//   `msg.time.completed = …; updateMessage(msg)` and only AFTER that
//   `part.state = { status: 'completed', …, output }; updatePart(part)`.
// - a slash command run by a subagent (`handleSubtask`): the assistant, a
//   `running` `task` tool part, then `assistantMessage.finish = 'tool-calls';
//   time.completed = Date.now(); updateMessage(…)` and only then
//   `updatePart({ … status: 'completed', output })`; on interrupt the same
//   order with `status: 'error', error: 'Cancelled'`.
//
// The single emitted record must equal the FINAL projection: consumers get
// one record per id and Agent Code's renderer drops repeats. The oracle is
// the rows this test writes, spelled out as the record the contract implies
// (ids from the columns), never a record the reader assembled.

const S = 'ses_holds'
const OTHER = 'ses_other'
const T = 1000

const base = { agent: 'build', mode: 'build', modelID: 'm', providerID: 'p', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, path: { cwd: '/x', root: '/x' } }
const user = (id: string, sessionID = S) => ({ id, sessionID, role: 'user', time: { created: T }, agent: 'build', model: { providerID: 'p', modelID: 'm' } })
const shellUserPart = (messageID: string) => ({ id: `prt_${messageID}_u`, messageID, sessionID: S, type: 'text', text: 'The following tool was executed by the user', synthetic: true })
const assistant = (id: string, parentID: string, extra: Record<string, unknown> = {}, sessionID = S) => ({ id, sessionID, role: 'assistant', parentID, time: { created: T + 1 }, ...base, ...extra })
const tool = (messageID: string, name: string, state: Record<string, unknown>) => ({ id: `prt_${messageID}_tool`, messageID, sessionID: S, type: 'tool', callID: 'call_1', tool: name, state })

let dir: string
let writer: LiveFixtureWriter | null
let store: OpencodeStore | null
let readers: DurableReader[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oth-holds-'))
  writer = null
  store = null
  readers = []
})
afterEach(() => {
  for (const reader of readers) reader.stop()
  store?.release()
  writer?.close()
  rmSync(dir, { recursive: true, force: true })
})

function setUp(sessionID = S) {
  if (!writer) {
    writer = new LiveFixtureWriter(join(dir, 'opencode.db'), S, sessionRowFor(S))
    store = openOpencodeStore(join(dir, 'opencode.db'))
  }
  const emitted: OpencodeMessageRecord[] = []
  const errors: DurableReaderError[] = []
  const reader = new DurableReader({ store: store!, sessionID, onRecords: records => emitted.push(...records), onError: error => errors.push(error) })
  readers.push(reader)
  reader.setLiveConnected(true)
  reader.start(-1)
  const row = (type: string, data: Record<string, unknown>, forSession = sessionID) => writer!.apply(type, data, forSession)
  const ids = () => emitted.map(record => record.info.id)
  return { emitted, errors, reader, row, ids }
}

describe('DurableReader holding an assistant completed before its tool settled', () => {
  it('a `!command` turn: emits the assistant once, after the tool part completed, with the output', () => {
    const { emitted, errors, reader, row, ids } = setUp()
    row('message.updated.1', { sessionID: S, info: user('msg_u') })
    row('message.part.updated.1', { sessionID: S, time: T, part: shellUserPart('msg_u') })
    row('message.updated.1', { sessionID: S, info: assistant('msg_a', 'msg_u') })
    const input = { command: 'ls' }
    row('message.part.updated.1', { sessionID: S, time: T + 2, part: tool('msg_a', 'shell', { status: 'running', time: { start: T + 2 }, input }) })
    row('message.part.updated.1', { sessionID: S, time: T + 3, part: tool('msg_a', 'shell', { status: 'running', time: { start: T + 2 }, input, metadata: { output: 'a.txt\n', description: '' } }) })
    expect(reader.drainNow().status).toBe('complete')
    expect(ids()).toEqual(['msg_u'])
    // finish: the message completes first…
    const completedInfo = assistant('msg_a', 'msg_u', { time: { created: T + 1, completed: T + 10 } })
    row('message.updated.1', { sessionID: S, info: completedInfo })
    expect(reader.drainNow().status).toBe('complete')
    expect(ids()).toEqual(['msg_u'])
    expect(reader.hasHeldAssistants()).toBe(true)
    // …then the part, with the output.
    const completedPart = tool('msg_a', 'shell', { status: 'completed', time: { start: T + 2, end: T + 10 }, input, title: '', metadata: { output: 'a.txt\nb.txt\n', description: '' }, output: 'a.txt\nb.txt\n' })
    row('message.part.updated.1', { sessionID: S, time: T + 11, part: completedPart })
    expect(reader.drainNow().status).toBe('complete')
    expect(reader.hasHeldAssistants()).toBe(false)
    expect(errors).toEqual([])
    expect(ids()).toEqual(['msg_u', 'msg_a'])
    expect(emitted[1]).toEqual({ info: completedInfo, parts: [completedPart] })
    // Nothing more, ever: one record per id.
    row('message.part.updated.1', { sessionID: S, time: T + 12, part: completedPart })
    reader.drainNow()
    expect(ids()).toEqual(['msg_u', 'msg_a'])
  })

  it('a subagent command turn: the `task` tool part settles after completion, and an interrupted one settles with its error', () => {
    const { emitted, reader, row, ids } = setUp()
    const input = { prompt: 'p', description: 'd', subagent_type: 'general' }
    row('message.updated.1', { sessionID: S, info: user('msg_u') })
    row('message.updated.1', { sessionID: S, info: assistant('msg_a', 'msg_u') })
    row('message.part.updated.1', { sessionID: S, time: T + 2, part: tool('msg_a', 'task', { status: 'running', input, time: { start: T + 2 } }) })
    const completedInfo = assistant('msg_a', 'msg_u', { finish: 'tool-calls', time: { created: T + 1, completed: T + 10 } })
    row('message.updated.1', { sessionID: S, info: completedInfo })
    reader.drainNow()
    expect(ids()).toEqual(['msg_u'])
    const completedPart = tool('msg_a', 'task', { status: 'completed', input, title: 'done', metadata: {}, output: 'result', attachments: [], time: { start: T + 2, end: T + 10 } })
    row('message.part.updated.1', { sessionID: S, time: T + 11, part: completedPart })
    reader.drainNow()
    expect(ids()).toEqual(['msg_u', 'msg_a'])
    expect(emitted[1]).toEqual({ info: completedInfo, parts: [completedPart] })

    // Interrupt: the same order, the part ends in `error`.
    row('message.updated.1', { sessionID: S, info: { ...user('msg_u2'), time: { created: T + 20 } } })
    row('message.updated.1', { sessionID: S, info: assistant('msg_b', 'msg_u2', { time: { created: T + 21 } }) })
    row('message.part.updated.1', { sessionID: S, time: T + 22, part: tool('msg_b', 'task', { status: 'running', input, time: { start: T + 22 } }) })
    const interruptedInfo = assistant('msg_b', 'msg_u2', { finish: 'tool-calls', time: { created: T + 21, completed: T + 30 } })
    row('message.updated.1', { sessionID: S, info: interruptedInfo })
    reader.drainNow()
    expect(reader.hasHeldAssistants()).toBe(true)
    const cancelled = tool('msg_b', 'task', { status: 'error', error: 'Cancelled', time: { start: T + 22, end: T + 30 }, metadata: undefined, input })
    row('message.part.updated.1', { sessionID: S, time: T + 31, part: cancelled })
    reader.drainNow()
    expect(reader.hasHeldAssistants()).toBe(false)
    expect(ids()).toEqual(['msg_u', 'msg_a', 'msg_u2', 'msg_b'])
    const { metadata: _undefined, ...cancelledStored } = cancelled.state
    expect(emitted[3]).toEqual({ info: interruptedInfo, parts: [{ ...cancelled, state: cancelledStored }] })
    // handleSubtask with task.command follows the result with a synthetic
    // summary prompt. It is a real prompt and must follow the task result.
    row('message.updated.1', { sessionID: S, info: { ...user('msg_summary'), time: { created: T + 32 } } })
    const summary = { id: 'prt_summary', messageID: 'msg_summary', sessionID: S, type: 'text', text: 'Summarize the task tool output above and continue with your task.', synthetic: true }
    row('message.part.updated.1', { sessionID: S, time: T + 32, part: summary })
    row('message.updated.1', { sessionID: S, info: assistant('msg_next', 'msg_summary', { time: { created: T + 33, completed: T + 34 } }) })
    reader.drainNow()
    expect(ids()).toEqual(['msg_u', 'msg_a', 'msg_u2', 'msg_b', 'msg_summary', 'msg_next'])
    expect(emitted[4]!.parts).toEqual([summary])
  })

  it('a prompt typed behind a held command waits for it, so conversation order holds', () => {
    const { reader, row, ids } = setUp()
    row('message.updated.1', { sessionID: S, info: user('msg_u') })
    row('message.updated.1', { sessionID: S, info: assistant('msg_a', 'msg_u') })
    row('message.part.updated.1', { sessionID: S, time: T + 2, part: tool('msg_a', 'shell', { status: 'running', input: {}, time: { start: T + 2 } }) })
    row('message.updated.1', { sessionID: S, info: assistant('msg_a', 'msg_u', { time: { created: T + 1, completed: T + 10 } }) })
    // The next prompt and its answer start while the shell output is still being written.
    row('message.updated.1', { sessionID: S, info: { ...user('msg_u2'), time: { created: T + 11 } } })
    row('message.part.updated.1', { sessionID: S, time: T + 11, part: { id: 'prt_u2', messageID: 'msg_u2', sessionID: S, type: 'text', text: 'next' } })
    row('message.updated.1', { sessionID: S, info: assistant('msg_b', 'msg_u2', { time: { created: T + 12 } }) })
    reader.drainNow()
    expect(ids()).toEqual(['msg_u'])
    row('message.part.updated.1', { sessionID: S, time: T + 13, part: tool('msg_a', 'shell', { status: 'completed', input: {}, time: { start: T + 2, end: T + 13 }, output: 'x' }) })
    reader.drainNow()
    expect(ids()).toEqual(['msg_u', 'msg_a', 'msg_u2'])
  })

  it('settleOpenWork hands a held assistant over as it stands when the caller cannot wait, once', () => {
    const { emitted, reader, row, ids } = setUp()
    row('message.updated.1', { sessionID: S, info: user('msg_u') })
    row('message.updated.1', { sessionID: S, info: assistant('msg_a', 'msg_u') })
    const running = tool('msg_a', 'shell', { status: 'running', input: { command: 'sleep 99' }, time: { start: T + 2 } })
    row('message.part.updated.1', { sessionID: S, time: T + 2, part: running })
    const completedInfo = assistant('msg_a', 'msg_u', { time: { created: T + 1, completed: T + 10 } })
    row('message.updated.1', { sessionID: S, info: completedInfo })
    reader.drainNow()
    expect(reader.hasHeldAssistants()).toBe(true)
    const settled = reader.settleOpenWork()
    expect(settled.status).toBe('complete')
    expect(settled.openAssistant).toBeNull()
    expect(reader.hasHeldAssistants()).toBe(false)
    expect(ids()).toEqual(['msg_u', 'msg_a'])
    expect(emitted[1]).toEqual({ info: completedInfo, parts: [running] })
    // The part completing later cannot re-emit it.
    row('message.part.updated.1', { sessionID: S, time: T + 20, part: tool('msg_a', 'shell', { status: 'completed', input: {}, time: { start: T + 2, end: T + 20 }, output: 'late' }) })
    reader.drainNow()
    expect(ids()).toEqual(['msg_u', 'msg_a'])
  })
})

describe('DurableReader and removed or foreign messages', () => {
  it('a pending prompt OpenCode removed is never committed: not by a flush, not by a later answer naming it', () => {
    const { reader, row, ids } = setUp()
    row('message.updated.1', { sessionID: S, info: user('msg_u') })
    row('message.part.updated.1', { sessionID: S, time: T, part: { id: 'prt_u', messageID: 'msg_u', sessionID: S, type: 'text', text: 'oops' } })
    reader.drainNow()
    // Undo in the TUI: revert removes the incomplete prompt (census finding 5).
    row('message.removed.1', { sessionID: S, messageID: 'msg_u' })
    reader.drainNow()
    expect(reader.flushPendingUsers()).toEqual({ status: 'complete', records: [] })
    expect(ids()).toEqual([])
    row('message.updated.1', { sessionID: S, info: assistant('msg_a', 'msg_u', { time: { created: T + 1, completed: T + 2 } }) })
    reader.drainNow()
    expect(ids()).toEqual(['msg_a'])
  })

  it('two sessions in one database: each reader emits only its own aggregate (census invariant 6)', () => {
    const own = setUp(S)
    writer!.addSession({ ...sessionRowFor(OTHER), id: OTHER, parent_id: S })
    const other = setUp(OTHER)
    // Interleaved writes, as a parent and its task child produce them.
    own.row('message.updated.1', { sessionID: S, info: user('msg_u') })
    other.row('message.updated.1', { sessionID: OTHER, info: user('msg_ou', OTHER) })
    other.row('message.part.updated.1', { sessionID: OTHER, time: T, part: { id: 'prt_ou', messageID: 'msg_ou', sessionID: OTHER, type: 'text', text: 'child prompt' } })
    own.row('message.updated.1', { sessionID: S, info: assistant('msg_a', 'msg_u', { time: { created: T + 1, completed: T + 2 } }) })
    other.row('message.updated.1', { sessionID: OTHER, info: assistant('msg_oa', 'msg_ou', { time: { created: T + 1, completed: T + 3 } }, OTHER) })
    own.reader.drainNow()
    other.reader.drainNow()
    expect(own.ids()).toEqual(['msg_u', 'msg_a'])
    expect(other.ids()).toEqual(['msg_ou', 'msg_oa'])
    expect(own.emitted.every(record => record.info.sessionID === S)).toBe(true)
    expect(other.emitted.every(record => record.info.sessionID === OTHER)).toBe(true)
    expect(own.reader.getCursor()).toBe(1)
    expect(other.reader.getCursor()).toBe(2)
  })
})
