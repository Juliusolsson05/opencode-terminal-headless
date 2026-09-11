// CommittedAssembler — decides WHEN an OpenCode message becomes a committed
// transcript record. It never decides WHAT the record contains: content is
// always loaded from OpenCode's projection at the moment of commit.
//
// Every rule below is argued from research/census-2026-09-10.md and, where the
// census corpus never exercised a code path, from OpenCode's source (cited as
// sst/opencode@v1.18.30 and checked against the installed 1.18.30 binary):
//
// - An assistant message commits on the event that sets `info.time.completed`,
//   and a commit is final: the record is emitted once and never amended.
//   Agent Code's renderer drops a repeated message id, so an amended re-emit
//   could not reach anyone even if we sent it. `finish` is written one event
//   earlier and is NOT the signal.
// - "Nothing changes an assistant after completion" (census hypothesis 3,
//   0 exceptions in 6,684 assistants) is true of turns run by
//   SessionProcessor, whose cleanup finalizes every part before it writes
//   completion. It is NOT true of two other writers the corpus never saw:
//   `SessionPrompt.shellImpl` (the TUI's `!command`) and
//   `SessionPrompt.handleSubtask` (a slash command run by a subagent). Both
//   write `time.completed` first and the final tool part (its output, or the
//   "Cancelled" error) one event later (packages/opencode/src/session/
//   prompt.ts; the same order is in the 1.18.30 binary; review R1-F1). So an
//   assistant whose projection still has a `pending` or `running` tool part
//   at its completion event is HELD instead of emitted, and re-checked on
//   every later event until every tool part has settled. `releaseHeld` emits
//   whatever is still held as it stands: the sequencer calls it when a turn
//   end has waited long enough, and at exit, when OpenCode will write nothing
//   more.
// - Commits leave in the order they were made. A held assistant blocks the
//   commits behind it (a prompt typed after a `!command` must not appear
//   before the command's result), so the output is a FIFO whose head may be
//   waiting.
// - A user message commits when the first assistant whose `parentID` is that
//   user appears. All of a prompt's parts are written before that point. Later
//   rewrites only ever change `summary` (or rewrite a compaction marker), so
//   they are ignored.
// - Pending user messages queued before the answered one commit first, in
//   arrival order, so the committed stream keeps conversation order when a
//   prompt was queued while the agent was busy (16/50 sessions do this).
// - `flushPendingUsers` commits whatever is still pending and has content.
//   The sequencer calls it when a live turn ends (a prompt aborted before the
//   model answered); the reader calls it from its disconnected poll, limited
//   to prompts that have waited a whole poll interval with no assistant open.
// - `message.removed` only cancels a pending user (and forgets an open
//   assistant). A removal of something already committed is not propagated:
//   consumers re-read history from the projection, which is already correct.
//   This matches the structured runtime.
//
// Open assistants: an assistant seen without `time.completed` is open until
// its completion (or removal) is seen. For an aborted or failed turn OpenCode
// publishes `idle` BEFORE it writes the completion row (SessionProcessor
// `.catch(halt)` runs before `.ensuring(cleanup)`; review R1-F2), so the
// sequencer asks `hasOpenAssistant()` before it lets the turn end overtake the
// answer, and calls `abandonOpenAssistants()` once it has stopped waiting, so
// an assistant OpenCode never completes cannot hold every later turn too.
//
// The class is pure and synchronous: no database, no timers. The caller passes
// a loader that reads the projection inside the same read transaction that
// produced the event, so event and content come from one snapshot.
//
// WHY unknown event names are no longer counted: the count had no reader
// (review R7-F14). Only the consumed types matter to the commit rules, and a
// new version of one of those still fails closed, below. A runtime signal for
// brand-new event families would need an event of its own on the composition;
// today the drift signal is support/upstream-versions.json plus the upstream
// watch workflow.

import { CONSUMED_EVENT_TYPES, type DurableEvent } from './OpencodeStore.js'
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

// Bound for users that are pending without ever getting parts, and for
// assistants that are open without ever completing. In practice at most a
// handful of either exist at once; the cap only stops a pathological log from
// growing the maps forever.
const MAX_TRACKED = 64

// Tool part states that OpenCode later overwrites with a final one
// (`completed` or `error`). Shape: packages/opencode/src/session/message-v2.ts
// ToolState; the census saw only `completed` and `error` in final projections.
const UNSETTLED_TOOL_STATES: ReadonlySet<unknown> = new Set(['pending', 'running'])

function hasUnsettledTool(record: OpencodeMessageRecord): boolean {
  return record.parts.some(part => part.type === 'tool' && UNSETTLED_TOOL_STATES.has((part.state as { status?: unknown } | undefined)?.status))
}

type Outgoing = { kind: 'ready'; record: OpencodeMessageRecord } | { kind: 'held'; messageID: string }

export class CommittedAssembler {
  // Every id committed, held or deliberately skipped. Unbounded on purpose: a
  // rewrite can arrive for any earlier message, and forgetting that it was
  // decided would commit it twice. Ids are tens of bytes each.
  private readonly committed = new Set<string>()
  // Insertion order is arrival order; the value is the first-seen seq.
  private readonly pendingUsers = new Map<string, number>()
  // Assistants seen without completion, in arrival order.
  private readonly openAssistants = new Map<string, number>()
  // Decided commits not yet handed out. Only a held assistant can stop here.
  private readonly outbox: Outgoing[] = []

  /** History owns these ids; later rewrites must never become live commits. */
  seedCommitted(messageIDs: readonly string[]): void {
    for (const id of messageIDs) this.committed.add(id)
  }

  apply(event: DurableEvent, load: CommitLoader): OpencodeMessageRecord[] {
    const supportedVersion = CONSUMED_EVENT_TYPES[event.name]
    if (supportedVersion !== undefined) {
      if (event.version !== supportedVersion) throw new DurableEventVersionError(event.name, event.version, event.seq)
      if (event.data) this.consume(event, load)
    }
    // Every event, consumed or not, re-checks a held head: the part update
    // that settles a held tool is a `message.part.updated`, whose payload the
    // store deliberately never reads.
    return this.drainOutbox(load, false)
  }

  /**
   * Commit every pending user message that has content, oldest first. With
   * `seenAtOrBefore`, only prompts first seen at or before that seq: the
   * reader's disconnected poll uses it so that a prompt OpenCode is still
   * writing (one part per transaction) is not committed without its later
   * parts, which a commit would never pick up.
   */
  flushPendingUsers(load: CommitLoader, opts: { seenAtOrBefore?: number } = {}): OpencodeMessageRecord[] {
    for (const [userID, seenAt] of [...this.pendingUsers]) {
      // Arrival order is seq order, so everything after this one is newer too.
      if (opts.seenAtOrBefore !== undefined && seenAt > opts.seenAtOrBefore) break
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
      this.outbox.push({ kind: 'ready', record })
    }
    return this.drainOutbox(load, false)
  }

  /** Emit held assistants as the projection has them now, settled or not. */
  releaseHeld(load: CommitLoader): OpencodeMessageRecord[] {
    return this.drainOutbox(load, true)
  }

  hasHeldAssistants(): boolean {
    return this.outbox.some(item => item.kind === 'held')
  }

  hasPendingUsers(): boolean {
    return this.pendingUsers.size > 0
  }

  hasOpenAssistant(): boolean {
    return this.openAssistants.size > 0
  }

  /** The newest assistant seen without completion, if any. */
  newestOpenAssistant(): string | null {
    let newest: string | null = null
    for (const messageID of this.openAssistants.keys()) newest = messageID
    return newest
  }

  /** Stop treating the open assistants as something to wait for. Their completion still commits them. */
  abandonOpenAssistants(): void {
    this.openAssistants.clear()
  }


  private consume(event: DurableEvent, load: CommitLoader): void {
    const data = event.data!
    if (event.name === 'message.removed') {
      const messageID = data.messageID
      if (typeof messageID === 'string') {
        this.pendingUsers.delete(messageID)
        this.openAssistants.delete(messageID)
      }
      return
    }

    const info = data.info as { id?: unknown; role?: unknown; parentID?: unknown; time?: { completed?: unknown } } | undefined
    if (!info || typeof info.id !== 'string') return
    const messageID = info.id

    if (info.role === 'user') {
      if (!this.committed.has(messageID) && !this.pendingUsers.has(messageID)) {
        this.pendingUsers.set(messageID, event.seq)
        trim(this.pendingUsers)
      }
      return
    }
    if (info.role !== 'assistant') return

    const parentID = typeof info.parentID === 'string' ? info.parentID : null
    if (parentID !== null && this.pendingUsers.has(parentID)) {
      const parentSeq = this.pendingUsers.get(parentID) ?? Number.POSITIVE_INFINITY
      for (const [userID, seenAt] of [...this.pendingUsers]) {
        if (seenAt > parentSeq) break
        this.commitUser(userID, load)
      }
    }
    if (typeof info.time?.completed === 'number') {
      this.openAssistants.delete(messageID)
      if (!this.committed.has(messageID)) this.commitAssistant(messageID, load)
    } else if (!this.committed.has(messageID) && !this.openAssistants.has(messageID)) {
      this.openAssistants.set(messageID, event.seq)
      trim(this.openAssistants)
    }
  }

  private commitUser(messageID: string, load: CommitLoader): void {
    this.pendingUsers.delete(messageID)
    this.committed.add(messageID)
    const record = load(messageID)
    // No row means the message was removed after this event (a replayed log
    // meeting a later revert): the projection, the authority, has nothing.
    if (record) this.outbox.push({ kind: 'ready', record })
  }

  private commitAssistant(messageID: string, load: CommitLoader): void {
    this.committed.add(messageID)
    const record = load(messageID)
    // No row: removed after this event, as above. An incomplete row cannot
    // meet its own completion event inside one read snapshot; skip it rather
    // than emit something that is not a finished answer.
    if (!record || !isCompletedAssistant(record)) return
    this.outbox.push(hasUnsettledTool(record) ? { kind: 'held', messageID } : { kind: 'ready', record })
  }

  // WHY the outbox is only shortened after the whole pass succeeded: `load`
  // reads the projection and can throw (a busy database, in the caller's
  // read transaction). Items taken out one by one before such a throw would
  // be neither returned nor still queued, so they would never be emitted.
  // Leaving the outbox untouched on a throw makes the retry re-run the same
  // pass; a ready item needs no load, and a held one is re-read anyway.
  private drainOutbox(load: CommitLoader, release: boolean): OpencodeMessageRecord[] {
    const out: OpencodeMessageRecord[] = []
    let taken = 0
    for (const item of this.outbox) {
      if (item.kind === 'held') {
        const record = load(item.messageID)
        // Reverted while held: nothing to commit, and nothing to wait for.
        if (record) {
          if (!release && hasUnsettledTool(record)) break
          out.push(record)
        }
      } else {
        out.push(item.record)
      }
      taken += 1
    }
    this.outbox.splice(0, taken)
    return out
  }
}

function trim(map: Map<string, number>): void {
  while (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}
