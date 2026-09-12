import { describe, expect, it } from 'vitest'

import { startConnected, useReplayRigs, type LogEntry, type Rig } from './testing/e2eRig.js'
import { loadLiveFixture } from './testing/fixtures.js'
import { sessionRowFor, waitUntil } from './testing/replay.js'
import { openOpencodeStore } from './transcript/OpencodeStore.js'

// The missing compositions from review R1/R8: real headless, HTTP/SSE, SQLite
// and PTY exit. The rows are hand-authored truth; abort ordering is from
// sst/opencode@v1.18.30 packages/opencode/src/session/processor.ts (halt publishes
// idle before cleanup writes completion). No private sequencer/reader access.
const { rig } = useReplayRigs()
const fixture = loadLiveFixture('plain.json')

async function bus(r: Rig, type: string, properties: Record<string, unknown>): Promise<void> {
  const before = r.headless.getLiveProgress().busEvents
  expect(r.server.send({ type, properties })).toBe(1)
  await waitUntil(() => r.headless.getLiveProgress().busEvents > before, 3000, `${type} applied`)
}
const status = (r: Rig, type: string, sessionID = r.sessionID) => bus(r, 'session.status', { sessionID, status: { type } })
const message = (r: Rig, info: Record<string, unknown>) => r.writer.apply('message.updated.1', { sessionID: r.sessionID, info: { sessionID: r.sessionID, ...info } })
const part = (r: Rig, messageID: string, text: string) => r.writer.apply('message.part.updated.1', {
  sessionID: r.sessionID, time: 1, part: { id: `prt_${messageID}`, messageID, sessionID: r.sessionID, type: 'text', text },
})
function prompt(r: Rig): void {
  message(r, { id: 'msg_u', role: 'user', time: { created: 1 } })
  part(r, 'msg_u', 'do it')
}
function answer(r: Rig, completed: boolean): void {
  part(r, 'msg_a', completed ? 'finished answer' : 'partial answer')
  message(r, { id: 'msg_a', role: 'assistant', parentID: 'msg_u', time: { created: 2, ...(completed ? { completed: 3 } : {}) } })
}
function order(log: LogEntry[]): string[] {
  return log.flatMap(e => {
    if (e.kind === 'entry') return [`entry:${e.record.info.id}`]
    if (e.kind === 'semantic' && e.event.type === 'turn_completed') return [`completed:${e.event.fullText}`]
    if (e.kind === 'semantic' && e.event.type === 'stream_phase' && e.event.phase === 'idle') return ['idle']
    if (e.kind === 'activity' && !e.active) return ['inactive']
    if (e.kind === 'error') return [`error:${e.error.code}`]
    if (e.kind === 'exit') return ['exit']
    return []
  })
}
const completed = (r: Rig) => r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_completed')

describe('OpencodeTerminalHeadless durable settlement', () => {
  it('flushes an unanswered prompt before completing its live turn', async () => {
    const r = await rig(fixture)
    await startConnected(r)
    const begin = r.log.length
    prompt(r)
    await status(r, 'busy')
    expect(order(r.log.slice(begin))).not.toContain('entry:msg_u')
    await status(r, 'idle')
    await waitUntil(() => completed(r), 3000, 'unanswered turn flush')
    expect(order(r.log.slice(begin))).toEqual(['entry:msg_u', 'completed:', 'idle', 'inactive'])
    expect(r.log.find(e => e.kind === 'entry')).toMatchObject({ record: { info: { id: 'msg_u', role: 'user' }, parts: [{ text: 'do it' }] } })
  })

  it('BUSY at turn end holds completion and idle until the committed answer is readable', async () => {
    const r = await rig(fixture)
    r.writer.setJournalMode('delete') // Real SQLITE_BUSY; see LiveFixtureWriter's WHY.
    await startConnected(r)
    const begin = r.log.length
    prompt(r)
    await status(r, 'busy')
    answer(r, true)
    r.writer.lock()
    try {
      await status(r, 'idle')
      expect(completed(r)).toBe(false)
      expect(order(r.log.slice(begin))).toEqual([])
    } finally { r.writer.unlock() }
    await waitUntil(() => completed(r), 3000, 'turn after lock release')
    expect(order(r.log.slice(begin))).toEqual(['entry:msg_u', 'entry:msg_a', 'completed:finished answer', 'idle', 'inactive'])
  })

  it('abort idle precedes cleanup in OpenCode, but the partial answer precedes completion in the host', async () => {
    const r = await rig(fixture)
    await startConnected(r)
    const begin = r.log.length
    prompt(r)
    await status(r, 'busy')
    answer(r, false)
    await bus(r, 'message.part.updated', { sessionID: r.sessionID, part: { id: 'prt_msg_a', messageID: 'msg_a', sessionID: r.sessionID, type: 'text', text: 'partial answer' } })
    await status(r, 'idle')
    await bus(r, 'session.idle', { sessionID: r.sessionID })
    expect(completed(r)).toBe(false)
    const info = { id: 'msg_a', role: 'assistant', parentID: 'msg_u', sessionID: r.sessionID, time: { created: 2, completed: 4 }, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }
    message(r, info)
    await bus(r, 'message.updated', { sessionID: r.sessionID, info })
    await waitUntil(() => completed(r), 3000, 'abort cleanup committed')
    expect(order(r.log.slice(begin))).toEqual(['entry:msg_u', 'entry:msg_a', 'completed:partial answer', 'idle', 'inactive'])
    expect(r.log.find(e => e.kind === 'entry' && e.record.info.id === 'msg_a')).toMatchObject({ record: { info: { error: info.error } } })
  })

  it('a task child found only through the store surfaces permission without starting a parent turn', async () => {
    const r = await rig(fixture)
    await startConnected(r)
    const child = 'ses_task_child'
    // No session.created bus event supplies ancestry: the package must ask
    // readSessionInfo, which reads the row addSession inserted in this file.
    r.writer.addSession({ ...sessionRowFor(child), id: child, parent_id: r.sessionID })
    const begin = r.log.length
    await status(r, 'busy', child)
    await bus(r, 'permission.asked', { id: 'per_child', sessionID: child, permission: 'bash', patterns: ['ls *'], always: ['*'], metadata: { command: 'ls .' } })
    expect(r.headless.getConditionSnapshot().conditions['opencode.permission']?.state).toMatchObject({ requestID: 'per_child' })
    expect(r.log.slice(begin).some(e => e.kind === 'semantic' && e.event.type === 'turn_started')).toBe(false)
    expect(r.headless.getActivity().active).toBe(false)
    await bus(r, 'permission.replied', { requestID: 'per_child', sessionID: child, reply: 'once' })
    expect(r.headless.getConditionSnapshot().conditions).toEqual({})
  })

  it('BUSY at exit retries the final drain and emits the answer before exit when the lock clears', async () => {
    const r = await rig(fixture)
    r.writer.setJournalMode('delete')
    await startConnected(r)
    const begin = r.log.length
    prompt(r)
    await status(r, 'busy')
    answer(r, true)
    r.writer.lock()
    try {
      r.pty.exit(1)
      expect(order(r.log.slice(begin))).toEqual([])
    } finally { r.writer.unlock() }
    await waitUntil(() => r.log.some(e => e.kind === 'exit'), 3000, 'final drain after lock release')
    expect(order(r.log.slice(begin))).toEqual(['entry:msg_u', 'entry:msg_a', 'completed:finished answer', 'idle', 'inactive', 'exit'])
  })

  it('BUSY through the exit deadline reports final_drain_incomplete before exit, with history still intact', async () => {
    const r = await rig(fixture)
    r.writer.setJournalMode('delete')
    await startConnected(r)
    const begin = r.log.length
    prompt(r)
    await status(r, 'busy')
    answer(r, true)
    r.writer.lock()
    try {
      r.pty.exit(1)
      expect(r.log.some(e => e.kind === 'exit')).toBe(false)
      await waitUntil(() => r.log.some(e => e.kind === 'exit'), 4000, 'bounded final-drain failure')
      expect(order(r.log.slice(begin))).toEqual(['completed:', 'idle', 'inactive', 'error:final_drain_incomplete', 'exit'])
    } finally { r.writer.unlock() }
    const history = openOpencodeStore(r.dbPath)
    try {
      expect(history.readHistory(r.sessionID).records.map(record => record.info.id)).toEqual(['msg_u', 'msg_a'])
    } finally { history.release() }
  }, 6000)
})
