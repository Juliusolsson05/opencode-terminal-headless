// CommittedAssembler — decides WHEN an OpenCode message becomes a committed
// transcript record. It never decides WHAT the record contains: content is
// always loaded from OpenCode's projection at the moment of commit.
//
// Every rule below is argued from research/census-2026-09-10.md:
//
// - An assistant message commits on the event that sets `info.time.completed`.
//   Nothing changes an assistant message after that write (0 exceptions in
//   6,684 messages), so one commit is final. `finish` is written one event
//   earlier and is NOT the signal.
// - A user message commits when the first assistant whose `parentID` is that
//   user appears. All of a prompt's parts are written before that point. Later
//   rewrites only ever change `summary` (or rewrite a compaction marker), so
//   they are ignored.
// - Pending user messages queued before the answered one commit first, in
//   arrival order, so the committed stream keeps conversation order when a
//   prompt was queued while the agent was busy (16/50 sessions do this).
// - `flushPendingUsers` commits whatever is still pending. The sequencer calls
//   it when a live turn ends, which covers prompts that never got an assistant
//   (aborted before the model answered).
// - `message.removed` only cancels a pending user. A removal of something
//   already committed is not propagated: consumers re-read history from the
//   projection, which is already correct. This matches the structured runtime.
//
// The class is pure and synchronous: no database, no timers. The caller passes
// a loader that reads the projection inside the same read transaction that
// produced the event, so event and content come from one snapshot.

import { CONSUMED_EVENT_TYPES, KNOWN_IGNORED_EVENT_NAMES, type DurableEvent } from './OpencodeStore.js'
import { isCompletedAssistant, type OpencodeMessageRecord } from './records.js'

export type CommitLoader = (messageID: string) => OpencodeMessageRecord | null

export class DurableEventVersionError extends Error {
  readonly code = 'event_version_unsupported'
  constructor(readonly eventName: string, readonly version: number, readonly seq: number) {
    super(
      `OpenCode durable event ${eventName}.${Number.isNaN(version) ? '?' : version} at seq ${seq} is not a version this reader understands; ` +
        'refusing to guess its shape (fail closed)',
    )
    this.name = 'DurableEventVersionError'
  }
}

// Bound for users that are pending without ever getting parts. In practice at
// most a handful are pending at once; the cap only stops a pathological log
// from growing the map forever.
const MAX_PENDING_USERS = 64

export class CommittedAssembler {
  // Every id committed or deliberately skipped. Unbounded on purpose: a
  // rewrite can arrive for any earlier user message, and forgetting that it
  // was committed would commit it twice. Ids are tens of bytes each.
  private readonly committed = new Set<string>()
  // Insertion order is arrival order; the value is the first-seen seq.
  private readonly pendingUsers = new Map<string, number>()
  private readonly unknownNames = new Map<string, number>()

  apply(event: DurableEvent, load: CommitLoader): OpencodeMessageRecord[] {
    const supportedVersion = CONSUMED_EVENT_TYPES[event.name]
    if (supportedVersion === undefined) {
      if (!KNOWN_IGNORED_EVENT_NAMES.has(event.name)) {
        this.unknownNames.set(event.name, (this.unknownNames.get(event.name) ?? 0) + 1)
      }
      return []
    }
    if (event.version !== supportedVersion) throw new DurableEventVersionError(event.name, event.version, event.seq)
    if (!event.data) return []

    if (event.name === 'message.removed') {
      const messageID = event.data.messageID
      if (typeof messageID === 'string') this.pendingUsers.delete(messageID)
      return []
    }

    const info = event.data.info as { id?: unknown; role?: unknown; parentID?: unknown; time?: { completed?: unknown } } | undefined
    if (!info || typeof info.id !== 'string') return []
    const messageID = info.id

    if (info.role === 'user') {
      if (!this.committed.has(messageID) && !this.pendingUsers.has(messageID)) {
        this.pendingUsers.set(messageID, event.seq)
        this.trimPending()
      }
      return []
    }
    if (info.role !== 'assistant') return []

    const out: OpencodeMessageRecord[] = []
    const parentID = typeof info.parentID === 'string' ? info.parentID : null
    if (parentID !== null && this.pendingUsers.has(parentID)) {
      const parentSeq = this.pendingUsers.get(parentID) ?? Number.POSITIVE_INFINITY
      for (const [userID, seenAt] of [...this.pendingUsers]) {
        if (seenAt > parentSeq) break
        const record = this.commit(userID, load)
        if (record) out.push(record)
      }
    }
    if (typeof info.time?.completed === 'number' && !this.committed.has(messageID)) {
      const record = this.commit(messageID, load)
      if (record) out.push(record)
    }
    return out
  }

  /** Commit every pending user message that has content. Called at turn end. */
  flushPendingUsers(load: CommitLoader): OpencodeMessageRecord[] {
    const out: OpencodeMessageRecord[] = []
    for (const userID of [...this.pendingUsers.keys()]) {
      const record = load(userID)
      if (!record) {
        // Removed from the projection since it was seen: nothing to commit.
        this.pendingUsers.delete(userID)
        this.committed.add(userID)
        continue
      }
      // A prompt with no parts yet is still being written; keep waiting.
      if (record.parts.length === 0) continue
      this.pendingUsers.delete(userID)
      this.committed.add(userID)
      out.push(record)
    }
    return out
  }

  isCommitted(messageID: string): boolean {
    return this.committed.has(messageID)
  }

  /** Event names outside the reader's vocabulary, with counts, for diagnostics. */
  unknownEventNames(): ReadonlyMap<string, number> {
    return this.unknownNames
  }

  private commit(messageID: string, load: CommitLoader): OpencodeMessageRecord | null {
    this.pendingUsers.delete(messageID)
    this.committed.add(messageID)
    const record = load(messageID)
    // No row means the message was removed after this event (a replayed log
    // meeting a later revert); an assistant row that is not complete cannot
    // happen for a committed event because completion is final. Either way the
    // projection — the authority — has nothing to commit.
    if (!record) return null
    if (record.info.role === 'assistant' && !isCompletedAssistant(record)) return null
    return record
  }

  private trimPending(): void {
    while (this.pendingUsers.size > MAX_PENDING_USERS) {
      const oldest = this.pendingUsers.keys().next().value
      if (oldest === undefined) break
      this.pendingUsers.delete(oldest)
    }
  }
}
