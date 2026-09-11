import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LiveFixtureWriter } from '../testing/fixtureDatabase.js'
import { listDurableFixtures, loadDurableFixture, type DurableFixture } from '../testing/fixtures.js'
import { commitFacts, projectionRecord } from '../testing/oracle.js'
import { waitUntil } from '../testing/replay.js'
import { DurableReader, type DurableReaderError } from './DurableReader.js'
import { openOpencodeStore, type OpencodeStore } from './OpencodeStore.js'
import type { OpencodeMessageRecord } from './records.js'

// The live-tail case: a writer applies a recorded session's events one at a
// time, exactly as OpenCode's projectors would (event row and projection rows
// in one immediate transaction), while the reader tails through a separate
// read-only connection. This is where commit TIMING is proven: each record must
// appear right after the event that makes it committable, and never before.
//
// Every recording runs, the 1,586-event compaction session included (a filter
// used to drop it without saying why; review R1-F7), with a batch size of 8 so
// every drain of an accumulated log crosses batch boundaries (review R3-F9).
// Hand-authored write orders (shell, subtask) live in DurableReader.holds; the
// failure modes (busy, throwing sink, checkpoint) in DurableReader.faults.

const FIXTURES = listDurableFixtures().map(name => ({ name, fixture: loadDurableFixture(name) }))
const BATCH = 8

let dir: string
let writer: LiveFixtureWriter | null
let store: OpencodeStore | null
let reader: DurableReader | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oth-reader-'))
  writer = null
  store = null
  reader = null
})
afterEach(() => {
  reader?.stop()
  store?.release()
  writer?.close()
  rmSync(dir, { recursive: true, force: true })
})

function setUp(fixture: DurableFixture, opts: { live: boolean; pollIntervalMs?: number }) {
  const file = join(dir, 'opencode.db')
  writer = new LiveFixtureWriter(file, fixture.meta.sessionID, fixture.session)
  store = openOpencodeStore(file)
  const emitted: Array<{ record: OpencodeMessageRecord; afterSeq: number }> = []
  const errors: DurableReaderError[] = []
  let lastApplied = -1
  reader = new DurableReader({
    store,
    sessionID: fixture.meta.sessionID,
    pollIntervalMs: opts.pollIntervalMs ?? 1000,
    batchSize: BATCH,
    onRecords: records => records.forEach(record => emitted.push({ record, afterSeq: lastApplied })),
    onError: error => errors.push(error),
  })
  reader.setLiveConnected(opts.live)
  reader.start()
  const apply = (type: string, data: Record<string, unknown>) => {
    lastApplied = writer!.apply(type, data)
    return lastApplied
  }
  return { emitted, errors, apply, reader: reader! }
}

// Committed records are immutable: OpenCode later adds summary metadata to
// users and tail_start_id to compaction parts (R1-F7). Neither rewrite changes
// visible prompt content, and consumers deduplicate ids, so compare both sides
// without those explicitly permitted later writes; retain every other field.
function withoutLaterRewrites(record: { info: Record<string, unknown>; parts: Record<string, unknown>[] }) {
  const { summary: _summary, ...info } = record.info
  const parts = record.parts.map(part => {
    if (part.type !== 'compaction') return part
    const { tail_start_id: _tail, ...stable } = part
    return stable
  })
  return { info, parts }
}

function expectContentAndTiming(fixture: DurableFixture, emitted: Array<{ record: OpencodeMessageRecord; afterSeq: number }>, flushed: readonly OpencodeMessageRecord[]): void {
  const facts = commitFacts(fixture)
  const ids = emitted.map(entry => entry.record.info.id)
  expect(new Set(ids).size).toBe(ids.length)
  // The writer derived its projection from the log; census invariant 7 says
  // that equals OpenCode's, so the fixture's projection is the oracle — plus
  // messages reverted only after they were committed, which a live tail
  // correctly emits before the revert happens.
  expect(new Set(ids)).toEqual(new Set([...facts.expected, ...facts.removedAfterCommit]))
  for (const { record, afterSeq } of emitted) {
    if (facts.removedAfterCommit.has(record.info.id)) {
      // No final row to compare content with; the commit point must still
      // be the normal one.
      if (record.info.role === 'assistant') expect(afterSeq).toBe(facts.completionSeq.get(record.info.id))
      continue
    }
    const final = projectionRecord(fixture, record.info.id)!
    if (record.info.role === 'assistant') {
      // Completion is final for SessionProcessor turns, which is every turn
      // in the corpus (census invariant 3): exact equality.
      expect(record).toEqual(final)
      expect(afterSeq).toBe(facts.completionSeq.get(record.info.id))
    } else {
      expect(withoutLaterRewrites(record)).toEqual(withoutLaterRewrites(final))
      const deadline = facts.deadlineOf(record.info.id)
      if (deadline === 'flush') expect(flushed).toContain(record)
      else expect(afterSeq).toBeLessThanOrEqual(deadline)
    }
  }
}

describe('DurableReader tailing a session being written', () => {
  for (const { name, fixture } of FIXTURES) {
    it(`${name}: emits each committable message right after the event that commits it`, () => {
      const { emitted, errors, apply, reader: tail } = setUp(fixture, { live: true })
      for (const event of fixture.events) {
        apply(event.type, event.data)
        expect(tail.drainNow().status).toBe('complete')
      }
      const flushed = tail.flushPendingUsers()
      expect(flushed.status).toBe('complete')
      expect(errors).toEqual([])
      expectContentAndTiming(fixture, emitted, flushed.records)
      // A finished SessionProcessor log leaves nothing held or open.
      expect(tail.hasHeldAssistants()).toBe(false)
      expect(tail.hasOpenAssistant()).toBe(false)
    })

    it(`${name}: drains a log written in one go across batch boundaries and ends at the head`, () => {
      const facts = commitFacts(fixture)
      const { emitted, errors, apply, reader: tail } = setUp(fixture, { live: true })
      for (const event of fixture.events) apply(event.type, event.data)
      const drained = tail.drainNow()
      expect(drained.status).toBe('complete')
      tail.flushPendingUsers()
      expect(errors).toEqual([])
      const ids = emitted.map(entry => entry.record.info.id)
      expect(new Set(ids).size).toBe(ids.length)
      // Replaying the whole log against its final projection: a message
      // reverted later has no row at its commit point, so it is not emitted.
      expect(new Set(ids)).toEqual(facts.expected)
      expect(fixture.events.length).toBeGreaterThan(BATCH)
      expect(tail.getCursor()).toBe(fixture.events[fixture.events.length - 1]!.seq)
    })
  }

  it('commits the synthetic compaction prompt once, at its first answer, and never again when OpenCode rewrites its marker part (census hypothesis 2)', () => {
    const withCompaction = FIXTURES.filter(entry => entry.fixture.meta.flags.compaction)
    // Non-vacuous: the corpus carries the shape (ses_5a9eb743…).
    expect(withCompaction.length).toBeGreaterThan(0)
    const { name, fixture } = withCompaction[0]!
    const facts = commitFacts(fixture)
    const { emitted, errors, apply, reader: tail } = setUp(fixture, { live: true })
    for (const event of fixture.events) {
      apply(event.type, event.data)
      tail.drainNow()
    }
    tail.flushPendingUsers()
    expect(errors).toEqual([])
    const compactionUsers = fixture.messages
      .filter(row => (row.data as { role?: string }).role === 'user' && fixture.parts.some(part => part.message_id === row.id && (part.data as { type?: string }).type === 'compaction'))
      .map(row => row.id)
    expect(compactionUsers.length, name).toBeGreaterThan(0)
    for (const id of compactionUsers) {
      const rewrites = fixture.events
        .filter(event => event.type === 'message.part.updated.1' && (event.data.part as { messageID?: string; type?: string }).messageID === id && (event.data.part as { type?: string }).type === 'compaction')
        .map(event => event.seq)
      // The census: the marker is written once and rewritten (with
      // tail_start_id) 7–11 events after the summary assistant starts.
      expect(rewrites.length, id).toBeGreaterThan(1)
      const commits = emitted.filter(entry => entry.record.info.id === id)
      expect(commits, id).toHaveLength(1)
      expect(commits[0]!.afterSeq).toBeLessThanOrEqual(facts.deadlineOf(id) as number)
      expect(commits[0]!.afterSeq).toBeLessThan(rewrites[rewrites.length - 1]!)
    }
  })

  it('does not read while live-connected until rung, then reads once', async () => {
    const fixture = FIXTURES[0]!.fixture
    const facts = commitFacts(fixture)
    const { emitted, apply, reader: tail } = setUp(fixture, { live: true, pollIntervalMs: 10 })
    for (const event of fixture.events) apply(event.type, event.data)
    // Negative window: a slow machine can only make this pass.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(emitted).toEqual([])
    tail.ring()
    tail.ring()
    await Promise.resolve()
    expect(emitted.length).toBeGreaterThan(0)
    expect(new Set(emitted.map(entry => entry.record.info.id)).size).toBe(emitted.length)
    expect(emitted.every(entry => facts.expected.has(entry.record.info.id))).toBe(true)
  })

  it('polls on its own while the live channel is disconnected', async () => {
    const fixture = FIXTURES[0]!.fixture
    const facts = commitFacts(fixture)
    const { emitted, apply } = setUp(fixture, { live: false, pollIntervalMs: 10 })
    for (const event of fixture.events) apply(event.type, event.data)
    const assistants = [...facts.expected].filter(id => projectionRecord(fixture, id)?.info.role === 'assistant')
    await waitUntil(() => assistants.every(id => emitted.some(entry => entry.record.info.id === id)), 3000, 'the poll to deliver every assistant')
  })

  it('with the live channel down, commits a prompt no answer names from the poll, before a later answer (review R1-F9)', async () => {
    const fixture = FIXTURES[0]!.fixture
    const S = fixture.meta.sessionID
    const { emitted, errors, apply } = setUp(fixture, { live: false, pollIntervalMs: 10 })
    apply('message.updated.1', { sessionID: S, info: { id: 'msg_u', sessionID: S, role: 'user', time: { created: 1 } } })
    apply('message.part.updated.1', { sessionID: S, time: 1, part: { id: 'prt_u', messageID: 'msg_u', sessionID: S, type: 'text', text: 'hi' } })
    // No turn ever ends (no live channel), and nobody calls flushPendingUsers.
    await waitUntil(() => emitted.some(entry => entry.record.info.id === 'msg_u'), 2000, 'the poll to flush the prompt')
    // An answer that names an EARLIER prompt (OpenCode resumes on `lastUser`)
    // would otherwise be the only thing ever to commit this one, after itself.
    apply('message.updated.1', { sessionID: S, info: { id: 'msg_a', sessionID: S, role: 'assistant', parentID: 'msg_earlier', time: { created: 2, completed: 3 } } })
    await waitUntil(() => emitted.some(entry => entry.record.info.id === 'msg_a'), 2000, 'the answer')
    expect(errors).toEqual([])
    expect(emitted.map(entry => entry.record.info.id)).toEqual(['msg_u', 'msg_a'])
  })

  it('stops with event_version_unsupported on an unknown version, after emitting what it understood', () => {
    const fixture = FIXTURES[0]!.fixture
    const { emitted, errors, apply, reader: tail } = setUp(fixture, { live: true })
    for (const event of fixture.events) apply(event.type, event.data)
    const before = tail.drainNow()
    expect(before.status).toBe('complete')
    expect(before.records.length).toBeGreaterThan(0)
    apply('message.updated.2', { sessionID: fixture.meta.sessionID, info: { id: 'msg_future', role: 'assistant' } })
    expect(tail.drainNow().status).toBe('failed')
    expect(errors.map(error => error.code)).toEqual(['event_version_unsupported'])
    expect(errors[0]!.fatal).toBe(true)
    const countAtFailure = emitted.length
    apply('message.updated.1', { sessionID: fixture.meta.sessionID, info: { id: 'msg_after', role: 'user', time: { created: 1 } } })
    expect(tail.drainNow().status).toBe('failed')
    expect(tail.flushPendingUsers().status).toBe('failed')
    expect(emitted.length).toBe(countAtFailure)
  })
})
