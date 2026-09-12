import { describe, expect, it } from 'vitest'

import { listDurableFixtures, loadDurableFixture, type DurableFixture } from '../testing/fixtures.js'
import { commitFacts, projectionRecord } from '../testing/oracle.js'
import { CommittedAssembler, DurableEventVersionError } from './CommittedAssembler.js'
import { CONSUMED_EVENT_TYPES, type DurableEvent } from './OpencodeStore.js'
import type { OpencodeMessageRecord } from './records.js'

// Every fixture is a real OpenCode 1.18.x session (sanitised). The assembler is
// replayed over its full log against its final projection and must commit
// exactly the messages the projection says are committable. Ordering is
// checked against facts read off the log itself, not against the assembler.
// The contract block below covers the rules no recording exercises, with
// hand-authored records as the oracle.

// Mirror the store: payloads are only fetched for consumed types. Derived
// from the reader's own table so a newly consumed type cannot drift from
// this test (the list used to be retyped here).
const consumed = new Set(Object.entries(CONSUMED_EVENT_TYPES).map(([name, version]) => `${name}.${version}`))

function asDurableEvents(fixture: DurableFixture): DurableEvent[] {
  return fixture.events.map(event => {
    const dot = event.type.lastIndexOf('.')
    return {
      seq: event.seq,
      name: event.type.slice(0, dot),
      version: Number(event.type.slice(dot + 1)),
      data: consumed.has(event.type) ? event.data : null,
    }
  })
}

function replay(fixture: DurableFixture): { commits: Array<{ record: OpencodeMessageRecord; seq: number | 'flush' }>; assembler: CommittedAssembler } {
  const assembler = new CommittedAssembler()
  const load = (id: string) => projectionRecord(fixture, id) as OpencodeMessageRecord | null
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
    const { commits, assembler } = replay(fixture)
    const ids = commits.map(commit => commit.record.info.id)

    it(`${name}: commits exactly the committable messages, each once`, () => {
      expect(new Set(ids).size).toBe(ids.length)
      expect(new Set(ids)).toEqual(facts.expected)
      // A finished log leaves nothing waiting: every recorded assistant was
      // written by SessionProcessor, which settles its tools before completing.
      expect(assembler.hasHeldAssistants()).toBe(false)
      expect(assembler.hasOpenAssistant()).toBe(false)
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

// Hand-authored shapes for the contract block. Each record is what OpenCode's
// projection would hold at that moment; the test mutates `projection` the way
// OpenCode's writes would.
const S = 'ses_contract'
const userRecord = (id: string, parts: number): OpencodeMessageRecord => ({
  info: { id, sessionID: S, role: 'user', time: { created: 1 } },
  parts: Array.from({ length: parts }, (_, index) => ({ id: `prt_${id}_${index}`, messageID: id, sessionID: S, type: 'text', text: `prompt ${id}` })),
})
const assistantRecord = (id: string, parentID: string, opts: { completed?: boolean; tool?: string } = {}): OpencodeMessageRecord => ({
  info: { id, sessionID: S, role: 'assistant', parentID, time: { created: 2, ...(opts.completed ? { completed: 3 } : {}) } },
  parts: opts.tool ? [{ id: `prt_${id}_tool`, messageID: id, sessionID: S, type: 'tool', tool: 'bash', callID: 'call_1', state: { status: opts.tool } }] : [],
})
const updated = (seq: number, record: OpencodeMessageRecord): DurableEvent => ({ seq, name: 'message.updated', version: 1, data: { info: record.info } })
const removed = (seq: number, messageID: string): DurableEvent => ({ seq, name: 'message.removed', version: 1, data: { messageID } })
const partUpdated = (seq: number): DurableEvent => ({ seq, name: 'message.part.updated', version: 1, data: null })

function contract() {
  const projection = new Map<string, OpencodeMessageRecord>()
  const load = (id: string) => projection.get(id) ?? null
  return { assembler: new CommittedAssembler(), projection, load }
}

describe('CommittedAssembler contract', () => {
  it('refuses a consumed event type at a version it does not understand (fail closed)', () => {
    const { assembler, load } = contract()
    expect(() => assembler.apply({ seq: 3, name: 'message.updated', version: 2, data: { info: {} } }, load)).toThrow(DurableEventVersionError)
  })

  it('skips every type it does not consume, whatever its name or version', () => {
    const { assembler, load } = contract()
    expect(assembler.apply({ seq: 0, name: 'message.part.updated', version: 1, data: null }, load)).toEqual([])
    expect(assembler.apply({ seq: 1, name: 'session.next.prompted', version: 7, data: null }, load)).toEqual([])
  })

  it('flushes an unanswered prompt once, and leaves a prompt with no parts yet pending (review R3-F1)', () => {
    const { assembler, projection, load } = contract()
    const answered = userRecord('msg_u1', 1)
    projection.set('msg_u1', answered)
    assembler.apply(updated(0, answered), load)
    expect(assembler.flushPendingUsers(load)).toEqual([answered])
    expect(assembler.flushPendingUsers(load)).toEqual([])

    const empty = userRecord('msg_u2', 0)
    projection.set('msg_u2', empty)
    assembler.apply(updated(1, empty), load)
    expect(assembler.flushPendingUsers(load)).toEqual([])
    expect(assembler.hasPendingUsers()).toBe(true)
    // Its parts land; the next flush commits it, with them.
    const written = userRecord('msg_u2', 2)
    projection.set('msg_u2', written)
    expect(assembler.flushPendingUsers(load)).toEqual([written])
  })

  it('flushes only prompts first seen at or before the given seq, oldest first', () => {
    const { assembler, projection, load } = contract()
    const first = userRecord('msg_u1', 1)
    const second = userRecord('msg_u2', 1)
    projection.set('msg_u1', first).set('msg_u2', second)
    assembler.apply(updated(4, first), load)
    assembler.apply(updated(9, second), load)
    expect(assembler.flushPendingUsers(load, { seenAtOrBefore: 8 })).toEqual([first])
    expect(assembler.flushPendingUsers(load, { seenAtOrBefore: 9 })).toEqual([second])
  })

  it('never commits a pending prompt that was removed, by flush or by a later answer', () => {
    const { assembler, projection, load } = contract()
    const prompt = userRecord('msg_u1', 1)
    projection.set('msg_u1', prompt)
    assembler.apply(updated(0, prompt), load)
    assembler.apply(removed(1, 'msg_u1'), load)
    projection.delete('msg_u1')
    expect(assembler.flushPendingUsers(load)).toEqual([])

    // The same shape where an answer naming it arrives afterwards: only the
    // answer commits. (The projection would no longer have the prompt; the
    // assembler must not even ask for it.)
    const again = contract()
    again.projection.set('msg_u1', prompt)
    again.assembler.apply(updated(0, prompt), again.load)
    again.assembler.apply(removed(1, 'msg_u1'), again.load)
    const answer = assistantRecord('msg_a1', 'msg_u1', { completed: true })
    again.projection.set('msg_a1', answer)
    expect(again.assembler.apply(updated(2, answer), again.load)).toEqual([answer])
  })

  it('holds an assistant completed before its tool settled, then emits it once, as finally written (review R1-F1)', () => {
    const { assembler, projection, load } = contract()
    const prompt = userRecord('msg_u1', 1)
    projection.set('msg_u1', prompt)
    assembler.apply(updated(0, prompt), load)
    // shellImpl order: completion first, the tool part still running.
    const early = assistantRecord('msg_a1', 'msg_u1', { completed: true, tool: 'running' })
    projection.set('msg_a1', early)
    expect(assembler.apply(updated(1, early), load)).toEqual([prompt])
    expect(assembler.hasHeldAssistants()).toBe(true)
    // A prompt typed right after must wait behind the held answer.
    const next = userRecord('msg_u2', 1)
    const nextAnswer = assistantRecord('msg_a2', 'msg_u2')
    projection.set('msg_u2', next).set('msg_a2', nextAnswer)
    assembler.apply(updated(2, next), load)
    expect(assembler.apply(updated(3, nextAnswer), load)).toEqual([])
    // The final part write settles it: one emission, the final content, and
    // the prompt behind it follows.
    const final = assistantRecord('msg_a1', 'msg_u1', { completed: true, tool: 'completed' })
    projection.set('msg_a1', final)
    expect(assembler.apply(partUpdated(4), load)).toEqual([final, next])
    expect(assembler.hasHeldAssistants()).toBe(false)
    expect(assembler.apply(partUpdated(5), load)).toEqual([])
  })

  it('releases a held assistant as it stands when told to stop waiting', () => {
    const { assembler, projection, load } = contract()
    const held = assistantRecord('msg_a1', 'msg_u0', { completed: true, tool: 'pending' })
    projection.set('msg_a1', held)
    expect(assembler.apply(updated(0, held), load)).toEqual([])
    expect(assembler.releaseHeld(load)).toEqual([held])
    expect(assembler.hasHeldAssistants()).toBe(false)
  })

  it('a loader throwing partway through a held outbox pass leaves the entire batch for retry', () => {
    const { assembler, projection, load } = contract()
    const first = assistantRecord('msg_a1', 'msg_u0', { completed: true, tool: 'running' })
    const second = assistantRecord('msg_a2', 'msg_u0', { completed: true, tool: 'running' })
    projection.set('msg_a1', first).set('msg_a2', second)
    assembler.apply(updated(0, first), load)
    assembler.apply(updated(1, second), load)
    // The first head now settles, but reading the next one fails before the
    // caller receives anything. Removing each visited item loses the first.
    const final = assistantRecord('msg_a1', 'msg_u0', { completed: true, tool: 'completed' })
    projection.set('msg_a1', final)
    expect(() => assembler.releaseHeld(id => {
      if (id === 'msg_a2') throw new Error('projection read failed')
      return load(id)
    })).toThrow('projection read failed')
    expect(assembler.releaseHeld(load)).toEqual([final, second])
    expect(assembler.releaseHeld(load)).toEqual([])
  })

  it('tracks an assistant as open from its creation until its completion or removal', () => {
    const { assembler, projection, load } = contract()
    const opened = assistantRecord('msg_a1', 'msg_u0')
    projection.set('msg_a1', opened)
    assembler.apply(updated(0, opened), load)
    expect(assembler.hasOpenAssistant()).toBe(true)
    expect(assembler.newestOpenAssistant()).toBe('msg_a1')
    const done = assistantRecord('msg_a1', 'msg_u0', { completed: true })
    projection.set('msg_a1', done)
    expect(assembler.apply(updated(1, done), load)).toEqual([done])
    expect(assembler.hasOpenAssistant()).toBe(false)

    const other = assistantRecord('msg_a2', 'msg_u0')
    assembler.apply(updated(2, other), load)
    assembler.apply(removed(3, 'msg_a2'), load)
    expect(assembler.hasOpenAssistant()).toBe(false)

    // Abandoning stops the waiting, not the commit.
    const stuck = assistantRecord('msg_a3', 'msg_u0')
    assembler.apply(updated(4, stuck), load)
    assembler.abandonOpenAssistants()
    expect(assembler.hasOpenAssistant()).toBe(false)
    const late = assistantRecord('msg_a3', 'msg_u0', { completed: true })
    projection.set('msg_a3', late)
    expect(assembler.apply(updated(5, late), load)).toEqual([late])
  })
})
