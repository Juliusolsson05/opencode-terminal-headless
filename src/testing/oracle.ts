// Test oracle for the durable reader, derived from facts about a recording —
// never from the reader's own mechanism.
//
// WHY an oracle and not expected-output snapshots: a snapshot of what the
// assembler produced today would bless whatever it does, including a bug. These
// expectations come from two independent sources: OpenCode's projection (which
// messages exist, which are complete, and their final content) and the event
// log (when each message first appeared and when each assistant completed).

import { buildMessageRecord, type OpencodeMessageRecord } from '../transcript/records.js'
import type { DurableFixture } from './fixtures.js'

export type CommitFacts = {
  /** Every id the durable tail must commit, exactly once. */
  expected: Set<string>
  /** Seq at which each id first appears in the log. */
  firstSeen: Map<string, number>
  /** Seq of the event that first carries `time.completed`, per assistant. */
  completionSeq: Map<string, number>
  /** Seq of the first assistant whose parentID is the user, per user. */
  firstAnswerSeq: Map<string, number>
  parentOf: Map<string, string>
  /**
   * Latest seq by which a prompt must be committed: the first answer to it OR
   * to any prompt written after it (conversation order keeps an unanswered,
   * aborted prompt ahead of the next answered one); 'flush' when no later
   * prompt was ever answered in this log.
   */
  deadlineOf(userID: string): number | 'flush'
  /**
   * Messages OpenCode removed (revert/undo) only AFTER they became
   * committable. A live tail legitimately commits these before the removal
   * happens; removal is not propagated (history reads the projection, which
   * no longer has them). A replay against the final projection cannot commit
   * them because their rows are gone.
   */
  removedAfterCommit: Set<string>
}

export function projectionRecord(fixture: DurableFixture, messageID: string): OpencodeMessageRecord | null {
  const row = fixture.messages.find(message => message.id === messageID)
  if (!row) return null
  const parts = fixture.parts
    .filter(part => part.message_id === messageID)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(part => ({ id: part.id, data: JSON.stringify(part.data) }))
  return buildMessageRecord(fixture.meta.sessionID, { id: row.id, data: JSON.stringify(row.data) }, parts)
}

export function commitFacts(fixture: DurableFixture): CommitFacts {
  const firstSeen = new Map<string, number>()
  const completionSeq = new Map<string, number>()
  const firstAnswerSeq = new Map<string, number>()
  const parentOf = new Map<string, string>()
  for (const event of fixture.events) {
    if (event.type !== 'message.updated.1') continue
    const info = event.data.info as { id: string; role: string; parentID?: string; time?: { completed?: number } }
    if (!firstSeen.has(info.id)) firstSeen.set(info.id, event.seq)
    if (info.role === 'assistant') {
      if (info.parentID) {
        parentOf.set(info.id, info.parentID)
        if (!firstAnswerSeq.has(info.parentID)) firstAnswerSeq.set(info.parentID, event.seq)
      }
      if (typeof info.time?.completed === 'number' && !completionSeq.has(info.id)) completionSeq.set(info.id, event.seq)
    }
  }
  const expected = new Set<string>()
  for (const id of firstSeen.keys()) {
    const record = projectionRecord(fixture, id)
    if (!record) continue // removed later: the projection has nothing to commit
    if (record.info.role === 'user' && record.parts.length > 0) expected.add(id)
    if (record.info.role === 'assistant' && typeof record.info.time.completed === 'number') expected.add(id)
  }
  const deadlineOf = (userID: string): number | 'flush' => {
    const seen = firstSeen.get(userID)
    if (seen === undefined) return 'flush'
    let best: number | null = null
    for (const [candidate, answeredAt] of firstAnswerSeq) {
      const candidateSeen = firstSeen.get(candidate)
      if (candidateSeen === undefined || candidateSeen < seen) continue
      if (best === null || answeredAt < best) best = answeredAt
    }
    return best ?? 'flush'
  }
  const removedAfterCommit = new Set<string>()
  const roleOf = new Map<string, string>()
  for (const event of fixture.events) {
    if (event.type === 'message.updated.1') {
      const info = event.data.info as { id: string; role: string }
      roleOf.set(info.id, info.role)
    } else if (event.type === 'message.removed.1') {
      const id = String(event.data.messageID)
      const committableAt = roleOf.get(id) === 'assistant' ? completionSeq.get(id) : deadlineOf(id)
      if (typeof committableAt === 'number' && committableAt < event.seq) removedAfterCommit.add(id)
    }
  }
  return { expected, firstSeen, completionSeq, firstAnswerSeq, parentOf, deadlineOf, removedAfterCommit }
}
