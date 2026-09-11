import { describe, expect, it } from 'vitest'

import { listDurableFixtures, loadDurableFixture, type DurableFixture } from '../testing/fixtures.js'
import { commitFacts, projectionRecord } from '../testing/oracle.js'
import { CommittedAssembler, DurableEventVersionError } from './CommittedAssembler.js'
import type { DurableEvent } from './OpencodeStore.js'
import type { OpencodeMessageRecord } from './records.js'

// Every fixture is a real OpenCode 1.18.x session (sanitised). The assembler is
// replayed over its full log against its final projection and must commit
// exactly the messages the projection says are committable. Ordering is
// checked against facts read off the log itself, not against the assembler.

function asDurableEvents(fixture: DurableFixture): DurableEvent[] {
  const consumed = new Set(['message.updated.1', 'message.removed.1'])
  return fixture.events.map(event => {
    const dot = event.type.lastIndexOf('.')
    return {
      seq: event.seq,
      name: event.type.slice(0, dot),
      version: Number(event.type.slice(dot + 1)),
      // Mirror the store: payloads are only fetched for consumed types.
      data: consumed.has(event.type) ? event.data : null,
    }
  })
}

function replay(fixture: DurableFixture): { commits: Array<{ record: OpencodeMessageRecord; seq: number | 'flush' }>; assembler: CommittedAssembler } {
  const assembler = new CommittedAssembler()
  const load = (id: string) => projectionRecord(fixture, id)
  const commits: Array<{ record: OpencodeMessageRecord; seq: number | 'flush' }> = []
  for (const event of asDurableEvents(fixture)) {
    for (const record of assembler.apply(event, load)) commits.push({ record, seq: event.seq })
  }
  for (const record of assembler.flushPendingUsers(load)) commits.push({ record, seq: 'flush' })
  return { commits, assembler }
}

describe('CommittedAssembler over recorded sessions', () => {
  for (const name of listDurableFixtures()) {
    const fixture = loadDurableFixture(name)
    const facts = commitFacts(fixture)
    const { commits } = replay(fixture)
    const ids = commits.map(commit => commit.record.info.id)

    it(`${name}: commits exactly the committable messages, each once`, () => {
      expect(new Set(ids).size).toBe(ids.length)
      expect(new Set(ids)).toEqual(facts.expected)
    })

    it(`${name}: commits the projection's content, not the event payload`, () => {
      for (const { record } of commits) expect(record).toEqual(projectionRecord(fixture, record.info.id))
    })

    it(`${name}: commits an assistant on the event that completes it`, () => {
      for (const { record, seq } of commits) {
        if (record.info.role !== 'assistant') continue
        expect(seq).toBe(facts.completionSeq.get(record.info.id))
      }
    })

    it(`${name}: commits a prompt by its deadline, and before its answer`, () => {
      const position = new Map(ids.map((id, index) => [id, index]))
      for (const { record, seq } of commits) {
        if (record.info.role !== 'user') continue
        const deadline = facts.deadlineOf(record.info.id)
        if (deadline === 'flush') {
          // No prompt at or after this one was ever answered in this log:
          // only the turn-end flush may commit it.
          expect(seq).toBe('flush')
        } else {
          expect(seq).not.toBe('flush')
          expect(seq as number).toBeLessThanOrEqual(deadline)
          expect(seq as number).toBeGreaterThanOrEqual(facts.firstSeen.get(record.info.id)!)
        }
      }
      for (const [assistantID, userID] of facts.parentOf) {
        if (position.has(assistantID) && position.has(userID)) {
          expect(position.get(userID)!).toBeLessThan(position.get(assistantID)!)
        }
      }
    })

    it(`${name}: keeps prompts in the order they were written`, () => {
      const userOrder = ids.filter(id => projectionRecord(fixture, id)?.info.role === 'user')
      const bySeen = [...userOrder].sort((a, b) => facts.firstSeen.get(a)! - facts.firstSeen.get(b)!)
      expect(userOrder).toEqual(bySeen)
    })
  }
})

describe('CommittedAssembler contract', () => {
  const load = () => null

  it('refuses a consumed event type at a version it does not understand (fail closed)', () => {
    const assembler = new CommittedAssembler()
    expect(() => assembler.apply({ seq: 3, name: 'message.updated', version: 2, data: { info: {} } }, load)).toThrow(DurableEventVersionError)
  })

  it('skips known-but-ignored types silently and counts unfamiliar ones', () => {
    const assembler = new CommittedAssembler()
    expect(assembler.apply({ seq: 0, name: 'message.part.updated', version: 1, data: null }, load)).toEqual([])
    expect(assembler.apply({ seq: 1, name: 'session.next.prompted', version: 1, data: null }, load)).toEqual([])
    expect([...assembler.unknownEventNames()]).toEqual([['session.next.prompted', 1]])
  })
})
