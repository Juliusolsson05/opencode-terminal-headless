import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LiveFixtureWriter } from '../testing/fixtureDatabase.js'
import { listDurableFixtures, loadDurableFixture, type DurableFixture } from '../testing/fixtures.js'
import { commitFacts, projectionRecord } from '../testing/oracle.js'
import { DurableReader, type DurableReaderError } from './DurableReader.js'
import { openOpencodeStore, type OpencodeStore } from './OpencodeStore.js'
import type { OpencodeMessageRecord } from './records.js'

// The live-tail case: a writer applies a recorded session's events one at a
// time, exactly as OpenCode's projectors would (event row and projection rows
// in one immediate transaction), while the reader tails through a separate
// read-only connection. This is where commit TIMING is proven: each record must
// appear right after the event that makes it committable, and never before.

const SMALL_FIXTURES = listDurableFixtures().filter(name => loadDurableFixture(name).events.length <= 600)

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

describe('DurableReader tailing a session being written', () => {
  for (const name of SMALL_FIXTURES) {
    it(`${name}: emits each committable message right after the event that commits it`, () => {
      const fixture = loadDurableFixture(name)
      const facts = commitFacts(fixture)
      const { emitted, errors, apply, reader: tail } = setUp(fixture, { live: true })
      for (const event of fixture.events) {
        apply(event.type, event.data)
        tail.drainNow()
      }
      const flushed = tail.flushPendingUsers()
      expect(errors).toEqual([])

      const ids = emitted.map(entry => entry.record.info.id)
      expect(new Set(ids).size).toBe(ids.length)
      // The writer derived its projection from the log; census invariant 7
      // says that equals OpenCode's, so the fixture's projection is the oracle
      // — plus messages reverted only after they were committed, which a live
      // tail correctly emits before the revert happens.
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
          // Completion is final (census invariant 3): exact equality.
          expect(record).toEqual(final)
        } else {
          // A prompt is committed at its first answer; OpenCode later rewrites
          // only `summary` on it (census finding 9). Everything else must
          // already match the final projection at commit time.
          const { summary: _committedSummary, ...committedInfo } = record.info
          const { summary: _finalSummary, ...finalInfo } = final.info
          expect({ ...record, info: committedInfo }).toEqual({ ...final, info: finalInfo })
        }
        if (record.info.role === 'assistant') expect(afterSeq).toBe(facts.completionSeq.get(record.info.id))
        if (record.info.role === 'user') {
          const deadline = facts.deadlineOf(record.info.id)
          if (deadline === 'flush') expect(flushed).toContain(record)
          else expect(afterSeq).toBeLessThanOrEqual(deadline)
        }
      }
    })
  }

  it('does not read while live-connected until rung, then reads once', async () => {
    const fixture = loadDurableFixture(SMALL_FIXTURES[0]!)
    const facts = commitFacts(fixture)
    const { emitted, apply, reader: tail } = setUp(fixture, { live: true, pollIntervalMs: 10 })
    for (const event of fixture.events) apply(event.type, event.data)
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
    const fixture = loadDurableFixture(SMALL_FIXTURES[0]!)
    const facts = commitFacts(fixture)
    const { emitted, apply } = setUp(fixture, { live: false, pollIntervalMs: 10 })
    for (const event of fixture.events) apply(event.type, event.data)
    const assistants = [...facts.expected].filter(id => projectionRecord(fixture, id)?.info.role === 'assistant')
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !assistants.every(id => emitted.some(entry => entry.record.info.id === id))) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    for (const id of assistants) expect(emitted.some(entry => entry.record.info.id === id)).toBe(true)
  })

  it('stops with event_version_unsupported on an unknown version, after emitting what it understood', () => {
    const fixture = loadDurableFixture(SMALL_FIXTURES[0]!)
    const { emitted, errors, apply, reader: tail } = setUp(fixture, { live: true })
    for (const event of fixture.events) apply(event.type, event.data)
    const before = tail.drainNow().length
    expect(before).toBeGreaterThan(0)
    apply('message.updated.2', { sessionID: fixture.meta.sessionID, info: { id: 'msg_future', role: 'assistant' } })
    tail.drainNow()
    expect(errors.map(error => error.code)).toEqual(['event_version_unsupported'])
    const countAtFailure = emitted.length
    apply('message.updated.1', { sessionID: fixture.meta.sessionID, info: { id: 'msg_after', role: 'user', time: { created: 1 } } })
    tail.drainNow()
    tail.flushPendingUsers()
    expect(emitted.length).toBe(countAtFailure)
  })
})
