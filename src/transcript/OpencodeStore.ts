// OpencodeStore — the only code in the package that issues SQL against
// OpenCode's database. Everything above it speaks records and durable events.
//
// WHY one shared read-only connection per database file: every OpenCode
// session on a machine lives in the same `opencode.db`. Agent Code may run many
// OpenCode Terminal panes plus history readers; one connection per pane would
// multiply file handles, WAL read marks and schema checks for no benefit. The
// registry is keyed by real path so `~/...` and a symlinked path share a
// handle, and reference counts close it when the last user releases it.
//
// WHY every read runs inside one transaction: the event cursor and the
// projection rows must describe the same moment. The census observed the race
// this prevents: a part rewritten between reading the log and reading the
// table made the two disagree (research/census-2026-09-10.md, invariant 7).
// In WAL mode a read transaction is a stable snapshot and never blocks
// OpenCode's writer.

import { realpathSync, statSync } from 'node:fs'

import { buildMessageRecord, type MessageRow, type OpencodeMessageRecord, type PartRow } from './records.js'
import { checkSchema } from './schema.js'
import { loadSqlite, SqliteUnavailableError, type SqliteDatabase, type SqliteStatement, type SqliteValue } from './sqlite.js'

export type OpencodeStoreErrorCode = 'sqlite_unavailable' | 'open_failed' | 'unsupported_schema' | 'busy' | 'read_failed'

export class OpencodeStoreError extends Error {
  constructor(readonly code: OpencodeStoreErrorCode, message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'OpencodeStoreError'
  }
}

// Durable event types whose payload the reader consumes, with the only schema
// version it understands. Every other type is scanned for its name only: the
// census saw `message.part.updated`, `session.created` and `session.updated`,
// OpenCode's source also writes `message.part.removed` and `session.deleted`,
// and the 1.18.30 binary defines newer names such as
// `session.next.shell.started`. None of them decides a commit; a part update
// only wakes a held assistant (CommittedAssembler).
export const CONSUMED_EVENT_TYPES: Readonly<Record<string, number>> = {
  'message.updated': 1,
  'message.removed': 1,
}

export type DurableEvent = {
  seq: number
  name: string
  version: number
  /** Parsed payload for consumed types; null for types scanned by name only. */
  data: Record<string, unknown> | null
}

export type OpencodeSessionInfo = {
  id: string
  parentID: string | null
  directory: string
  title: string
  timeUpdated: number
  /**
   * The agent and model this session last ran with, as OpenCode itself
   * persisted them.
   *
   * WHY this is read at all: a programmatic prompt MUST send the agent, model
   * and variant explicitly. Omitting them does not mean "use the session's
   * choice" — in 1.18.30 `SessionPrompt.createUserMessage` falls back to
   * `Agent.defaultInfo()`, the configured DEFAULT agent, and then persists that
   * replacement with `Session.setAgentModel`. A user on `plan` who received a
   * prompt from Agent Code would silently be moved to `build`, losing that
   * agent's tool policy along with the model variant.
   *
   * WHY the session row and not an HTTP round-trip: `setAgentModel` writes
   * exactly these two fields onto this row, so it IS OpenCode's own record of
   * the selection, and reading it costs nothing on a statement we already run.
   *
   * The known limit: the row records the selection that has last been USED.
   * A choice the user changed in the TUI but has not prompted with yet is not
   * observable here, and we do not pretend otherwise.
   */
  selection: OpencodeSessionSelection
}

/** Null fields mean the row has never recorded a choice; send nothing for them. */
export type OpencodeSessionSelection = {
  agent: string | null
  providerID: string | null
  modelID: string | null
  variant: string | null
}

export type HistoryPage = { records: OpencodeMessageRecord[]; hasOlder: boolean }

export type OpencodeReadTransaction = {
  cursor(sessionID: string): number
  historyMessageIDs(sessionID: string): string[]
  eventsAfter(sessionID: string, afterSeq: number, limit: number): DurableEvent[]
  loadMessage(sessionID: string, messageID: string): OpencodeMessageRecord | null
}

export type OpencodeStore = {
  readonly dbPath: string
  read<T>(fn: (tx: OpencodeReadTransaction) => T): T
  cursor(sessionID: string): number
  /**
   * One window of the session's projection, newest-first by window and
   * oldest-first within it. `beforeMessageID` names the oldest message the
   * host already has; when OpenCode has since removed it (a revert), the
   * window continues below that id instead of ending (see the statement).
   */
  readHistory(sessionID: string, opts?: { limit?: number; beforeMessageID?: string }): HistoryPage
  /**
   * Number of messages the session holds in OpenCode's projection. Hosts use
   * it where a JSONL provider reports its record count (Agent Code's scroll
   * indicator and its "has this session written anything yet" check).
   */
  countMessages(sessionID: string): number
  /**
   * Every message of the session, oldest first, read `pageSize` messages at a
   * time. For whole-session consumers (a host's transcript search) that must
   * not hold a long session in memory at once.
   */
  iterateMessages(sessionID: string, opts?: { pageSize?: number }): Generator<OpencodeMessageRecord, void, undefined>
  readSessionInfo(sessionID: string): OpencodeSessionInfo | null
  /** Root sessions for Resume; omit directory for the host's global listing. */
  listSessions(opts: { directory?: string; limit: number }): Array<{ id: string; title: string; directory: string; timeUpdated: number; timeCreated: number }>
  release(): void
}

type Statements = {
  cursor: SqliteStatement
  historyMessageIDs: SqliteStatement
  events: SqliteStatement
  message: SqliteStatement
  parts: SqliteStatement
  historyNewest: SqliteStatement
  historyAnchor: SqliteStatement
  historyBefore: SqliteStatement
  historyBelowRemovedAnchor: SqliteStatement
  forwardAfter: SqliteStatement
  session: SqliteStatement
  sessions: SqliteStatement
  count: SqliteStatement
}

type FileIdentity = { dev: bigint; ino: bigint }
type Entry = { db: SqliteDatabase; statements: Statements; refs: number; depth: number; identity: FileIdentity }

const registry = new Map<string, Entry>()
// Old generations remain alive for existing leases after replacement. The
// registry selects the current generation; this set counts actual connections.
const connections = new Set<Entry>()
const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino

const consumedTypeList = Object.entries(CONSUMED_EVENT_TYPES)
  .map(([name, version]) => `'${name}.${version}'`)
  .join(', ')

function prepareStatements(db: SqliteDatabase): Statements {
  return {
    cursor: db.prepare('SELECT seq FROM event_sequence WHERE aggregate_id = ?'),
    // WHY seed from the projection, not the skipped event prefix: imported
    // messages have no events, and OpenCode may rewrite any old user summary
    // after positioning. History owns every existing prompt and completed
    // answer. Incomplete assistants must remain eligible for live completion.
    // Only ids cross into JS; one session scan happens once at pane startup.
    historyMessageIDs: db.prepare(
      `SELECT id FROM message WHERE session_id = ? AND
       (json_extract(data, '$.role') = 'user' OR
        (json_extract(data, '$.role') = 'assistant' AND json_type(data, '$.time.completed') IN ('integer', 'real')))`,
    ),
    // WHY `data` only for consumed types: part updates dominate the log
    // (70,617 of 105,623 rows in the census) and carry tool output. SQLite
    // does not read a row's overflow pages unless the column is selected, so
    // scanning names is cheap even when the payloads are large.
    events: db.prepare(
      `SELECT seq, type, CASE WHEN type IN (${consumedTypeList}) THEN data END AS data
       FROM event WHERE aggregate_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    ),
    message: db.prepare('SELECT id, data FROM message WHERE id = ? AND session_id = ?'),
    parts: db.prepare('SELECT id, data FROM part WHERE message_id = ? ORDER BY id'),
    historyNewest: db.prepare(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?',
    ),
    historyAnchor: db.prepare('SELECT time_created FROM message WHERE id = ? AND session_id = ?'),
    historyBefore: db.prepare(
      `SELECT id, data FROM message WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))
       ORDER BY time_created DESC, id DESC LIMIT ?`,
    ),
    // WHY a second "before" statement keyed on the id alone: the host pages
    // by naming the oldest message it already shows, and the only thing that
    // removes a message OpenCode has written is a revert, which may take that
    // very anchor with it. The anchor's time_created is then gone, and the
    // (time_created, id) key above cannot be formed; answering "nothing older"
    // stranded the host's scroll-back until a full reload (review R1-F6).
    //
    // WHY `id < anchor` is the right continuation: OpenCode mints message ids
    // with `Identifier.ascending` (sst/opencode@v1.18.30
    // packages/opencode/src/id/id.ts, the same module is in the installed
    // 1.18.30 binary): the first 12 hex digits encode Date.now() * 0x1000
    // plus a per-millisecond counter, so the ids it mints sort in creation
    // order. A revert removes a suffix of the conversation (session/revert.ts
    // `cleanup`; in 1.18.30 everything from the revert point to the end of
    // the session's message list), so every survivor older than the removed
    // anchor was minted before it and sorts below it. Checked on the
    // recordings: in every durable fixture the ids OpenCode minted sort in
    // (time_created, id) order (all 111 logged messages of ses_5a9eb743, and
    // every message of the other six). Rows still come back in the usual
    // (time_created, id) order, and the host's next request anchors on a row
    // that exists, so paging returns to the exact key at once.
    //
    // What would make it wrong: ids OpenCode did not mint. `opencode import`
    // keeps the ids it is given, and the 17-message imported prefix of
    // ses_5a9eb743 carries 32-hex ids that do not sort by time. If this one
    // fallback page reaches such a prefix, an imported message whose id
    // happens to sort above the anchor is left out of it. That takes a revert
    // past everything the host has loaded, in a session long enough to page,
    // that began with an import. Exactness would need the host to carry the
    // anchor's time_created as well (upstream's own page cursor encodes both:
    // session/message-v2.ts `page`); nothing asks for that yet.
    historyBelowRemovedAnchor: db.prepare(
      'SELECT id, data FROM message WHERE session_id = ? AND id < ? ORDER BY time_created DESC, id DESC LIMIT ?',
    ),
    // The same (time_created, id) order as history, walked forward from a
    // key rather than a message id, so a message removed between pages cannot
    // strand the walk (see iterateMessages).
    forwardAfter: db.prepare(
      `SELECT id, time_created FROM message WHERE session_id = ? AND (time_created > ? OR (time_created = ? AND id > ?))
       ORDER BY time_created, id LIMIT ?`,
    ),
    session: openSessionStatement(db),
    // WHY root-only and exact directory: task children are implementation
    // details, not conversations the Resume picker should offer. Prefix path
    // matching would mix adjacent projects. The optional directory also lets
    // the host's global picker use this same source of truth (J2/J3 feature D).
    // time_created is now required by this public contract; unlike the deleted
    // child-query sort, it is a real reader of that column (see schema.ts).
    sessions: db.prepare(
      `SELECT id, title, directory, time_updated, time_created FROM session
       WHERE parent_id IS NULL AND (? IS NULL OR directory = ?)
       ORDER BY time_updated DESC, id DESC LIMIT ?`,
    ),
    // Covered by message_session_time_created_id_idx; no table scan.
    count: db.prepare('SELECT count(*) AS n FROM message WHERE session_id = ?'),
  }
}

// node:sqlite reports SQLite result codes on `errcode`. BUSY (5) and LOCKED
// (6) are transient beside a live writer — the caller retries on its next
// wake-up. Every other SQLite error is a real failure.
//
// WHY non-SQLite errors pass through untouched: the read callback runs caller
// logic (the assembler), whose typed errors — a fail-closed version refusal —
// must reach the caller as themselves, not disguised as a storage failure.
function translate(error: unknown, context: string): unknown {
  if (error instanceof OpencodeStoreError) return error
  const code = (error as { code?: unknown })?.code
  const errcode = (error as { errcode?: unknown })?.errcode
  if (code !== 'ERR_SQLITE_ERROR' && typeof errcode !== 'number') return error
  const base = typeof errcode === 'number' ? errcode & 0xff : null
  if (base === 5 || base === 6) return new OpencodeStoreError('busy', `${context}: database busy`, error)
  return new OpencodeStoreError('read_failed', `${context}: ${error instanceof Error ? error.message : String(error)}`, error)
}

/**
 * Prepare the single-session read, including the selection columns only when
 * this database actually has them.
 *
 * WHY a probe rather than a required column: `agent` and `model` matter for
 * prompting, not for reading a transcript. A build without them must still get
 * working history, so their absence degrades to "we do not know the selection"
 * instead of failing the schema gate and stopping the durable channel. Probing
 * once at prepare time keeps every later read on one prepared statement.
 */
function openSessionStatement(db: SqliteDatabase): SqliteStatement {
  let columns = 'id, parent_id, directory, title, time_updated'
  try {
    const present = new Set(db.prepare('PRAGMA table_info("session")').all().map(row => String(row.name)))
    if (present.has('agent')) columns += ', agent'
    if (present.has('model')) columns += ', model'
  } catch {
    // A PRAGMA that cannot answer leaves the base columns, which the schema
    // gate has already proven exist.
  }
  return db.prepare(`SELECT ${columns} FROM session WHERE id = ?`)
}

/**
 * Read the session's persisted agent/model selection.
 *
 * WHY this tolerates every shape instead of validating one: `session.model` is
 * written by OpenCode as a JSON object (`{id, providerID, variant}` in 1.18.30),
 * but this column is not part of any contract we control, and the schema gate
 * only promises the column EXISTS. A malformed or future-shaped value must
 * degrade to "we do not know the selection" — which makes the prompt behave
 * exactly as it did before we read it at all — rather than throwing and taking
 * down a history read that has nothing to do with prompting.
 */
function readSelection(row: Record<string, unknown>): OpencodeSessionSelection {
  const agent = typeof row.agent === 'string' && row.agent.length > 0 ? row.agent : null
  let model: Record<string, unknown> | null = null
  if (row.model != null) {
    try {
      const parsed: unknown = typeof row.model === 'string' ? JSON.parse(row.model) : row.model
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        model = parsed as Record<string, unknown>
      }
    } catch {
      model = null
    }
  }
  const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
  // OpenCode stores the model id under `id`, not `modelID`: `setAgentModel`
  // writes `{ id: model.modelID, providerID, variant }`. Accept `modelID` too,
  // because the same logical field is spelled that way on the prompt input and
  // a future writer could converge on it.
  const variant = model ? text(model.variant) : null
  return {
    agent,
    providerID: model ? text(model.providerID) : null,
    modelID: model ? (text(model.id) ?? text(model.modelID)) : null,
    // "default" is OpenCode's own sentinel for "no variant chosen", written by
    // `setAgentModel` as `variant ?? "default"`. Forwarding it verbatim would
    // pin the prompt to a literal variant named "default" and suppress the
    // agent's configured one, so it is normalised back to "unset" here.
    variant: variant === 'default' ? null : variant,
  }
}

function parseEventType(type: string): { name: string; version: number } {
  const dot = type.lastIndexOf('.')
  const suffix = dot > 0 ? type.slice(dot + 1) : ''
  return /^\d+$/.test(suffix) ? { name: type.slice(0, dot), version: Number(suffix) } : { name: type, version: Number.NaN }
}

function rowsAs<T>(rows: Array<Record<string, unknown>>): T[] {
  return rows as unknown as T[]
}

function makeTransaction(statements: Statements): OpencodeReadTransaction {
  const loadMessage = (sessionID: string, messageID: string): OpencodeMessageRecord | null => {
    const row = statements.message.get(messageID, sessionID) as MessageRow | undefined
    if (!row) return null
    const parts = rowsAs<PartRow>(statements.parts.all(messageID))
    return buildMessageRecord(sessionID, { id: String(row.id), data: String(row.data) }, parts.map(p => ({ id: String(p.id), data: String(p.data) })))
  }
  return {
    cursor(sessionID) {
      const row = statements.cursor.get(sessionID)
      return row ? Number(row.seq) : -1
    },
    historyMessageIDs(sessionID) {
      return statements.historyMessageIDs.all(sessionID).map(row => String(row.id))
    },
    eventsAfter(sessionID, afterSeq, limit) {
      return statements.events.all(sessionID, afterSeq, limit).map(row => {
        const { name, version } = parseEventType(String(row.type))
        let data: Record<string, unknown> | null = null
        if (typeof row.data === 'string') {
          try {
            data = JSON.parse(row.data) as Record<string, unknown>
          } catch {
            data = null
          }
        }
        return { seq: Number(row.seq), name, version, data }
      })
    },
    loadMessage,
  }
}

class Handle implements OpencodeStore {
  private released = false
  constructor(readonly dbPath: string, private readonly key: string, private readonly entry: Entry) {}

  read<T>(fn: (tx: OpencodeReadTransaction) => T): T {
    if (this.released) throw new OpencodeStoreError('read_failed', 'OpencodeStore handle used after release')
    const entry = this.entry
    const outermost = entry.depth === 0
    try {
      // Re-entrant reads join the outer transaction: nested BEGIN is an error
      // in SQLite, and one snapshot is exactly what a nested read wants.
      if (outermost) entry.db.exec('BEGIN')
      entry.depth += 1
      try {
        return fn(makeTransaction(entry.statements))
      } finally {
        entry.depth -= 1
        if (outermost) {
          try {
            entry.db.exec('COMMIT')
          } catch {
            // A read-only transaction has nothing to lose; make sure the
            // connection is not left inside it.
            try { entry.db.exec('ROLLBACK') } catch { /* already closed */ }
          }
        }
      }
    } catch (error) {
      throw translate(error, 'OpenCode store read')
    }
  }

  cursor(sessionID: string): number {
    return this.read(tx => tx.cursor(sessionID))
  }

  readHistory(sessionID: string, opts: { limit?: number; beforeMessageID?: string } = {}): HistoryPage {
    const limit = Math.max(1, Math.floor(opts.limit ?? 200))
    return this.read(tx => {
      const statements = this.entry.statements
      let rows: Array<Record<string, unknown>>
      if (opts.beforeMessageID) {
        const anchor = statements.historyAnchor.get(opts.beforeMessageID, sessionID)
        if (anchor) {
          const created = Number(anchor.time_created) as SqliteValue
          rows = statements.historyBefore.all(sessionID, created, created, opts.beforeMessageID, limit + 1)
        } else {
          // The anchor was reverted away; see historyBelowRemovedAnchor.
          rows = statements.historyBelowRemovedAnchor.all(sessionID, opts.beforeMessageID, limit + 1)
        }
      } else {
        rows = statements.historyNewest.all(sessionID, limit + 1)
      }
      const hasOlder = rows.length > limit
      const records: OpencodeMessageRecord[] = []
      // Rows arrive newest-first so LIMIT picks the right window; records are
      // returned oldest-first, the order every consumer renders in.
      for (const row of rows.slice(0, limit).reverse()) {
        const record = tx.loadMessage(sessionID, String(row.id))
        if (record) records.push(record)
      }
      return { records, hasOlder }
    })
  }

  countMessages(sessionID: string): number {
    return this.read(() => Number(this.entry.statements.count.get(sessionID)?.n ?? 0))
  }

  // WHY pages, each in its own read transaction, instead of one snapshot for
  // the whole walk: a generator is resumed on the consumer's schedule, and a
  // read transaction held open across those pauses would pin OpenCode's WAL
  // (it cannot checkpoint past a reader's mark) for as long as a host takes to
  // search a long session. Each page is a consistent snapshot; between pages
  // the walk sees OpenCode's later commits, which is what a reader of a live
  // session wants anyway: messages appended meanwhile are included, and one
  // removed meanwhile is skipped rather than ending the walk, because the
  // cursor is a (time_created, id) key, not a row that must still exist.
  *iterateMessages(sessionID: string, opts: { pageSize?: number } = {}): Generator<OpencodeMessageRecord, void, undefined> {
    // WHY 100 per page by default: a page is one short read transaction that
    // materializes up to 100 records (each message with all of its parts, so
    // tool output included) before the consumer sees the first one. Long agent
    // turns carry tool parts of tens of kilobytes, so 100 keeps a page in the
    // low megabytes, while a 1,000-message session still costs only ten
    // transactions. Nothing depends on the exact value; the walk is correct for
    // any size (the tests use 2 and 3 to force many page boundaries), and a
    // caller with a different memory/latency trade passes `pageSize`.
    const pageSize = Math.max(1, Math.floor(opts.pageSize ?? 100))
    // time_created is epoch milliseconds, never negative, and every id sorts
    // after the empty string, so this key precedes the first message.
    let afterCreated = -1
    let afterID = ''
    for (;;) {
      const page = this.read(tx => {
        const rows = this.entry.statements.forwardAfter.all(sessionID, afterCreated, afterCreated, afterID, pageSize)
        const records: OpencodeMessageRecord[] = []
        for (const row of rows) {
          const record = tx.loadMessage(sessionID, String(row.id))
          if (record) records.push(record)
        }
        const last = rows[rows.length - 1]
        return { records, last: last ? { created: Number(last.time_created), id: String(last.id) } : null, full: rows.length === pageSize }
      })
      yield* page.records
      if (!page.last || !page.full) return
      afterCreated = page.last.created
      afterID = page.last.id
    }
  }

  readSessionInfo(sessionID: string): OpencodeSessionInfo | null {
    return this.read(() => {
      const row = this.entry.statements.session.get(sessionID)
      if (!row) return null
      return {
        id: String(row.id),
        parentID: row.parent_id == null ? null : String(row.parent_id),
        directory: String(row.directory),
        title: String(row.title),
        timeUpdated: Number(row.time_updated),
        selection: readSelection(row),
      }
    })
  }


  listSessions(opts: { directory?: string; limit: number }): Array<{ id: string; title: string; directory: string; timeUpdated: number; timeCreated: number }> {
    const directory = opts.directory ?? null
    const limit = Math.max(1, Math.floor(opts.limit))
    return this.read(() => this.entry.statements.sessions.all(directory, directory, limit).map(row => ({
      id: String(row.id), title: String(row.title), directory: String(row.directory),
      timeUpdated: Number(row.time_updated), timeCreated: Number(row.time_created),
    })))
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.entry.refs -= 1
    if (this.entry.refs === 0) {
      // An old lease must never evict the replacement opened at the same
      // path: that would split its next opener into a third shared connection.
      if (registry.get(this.key) === this.entry) registry.delete(this.key)
      connections.delete(this.entry)
      try { this.entry.db.close() } catch { /* already closed */ }
    }
  }
}

/**
 * How many shared connections are open, including leased old file generations.
 *
 * A test seam, deliberately narrow: whether two handles share one connection
 * is the registry's whole point (the header above), and nothing in a handle's
 * public API can observe it, because two separate connections would read the
 * same rows just as well. Counting entries lets the realpath key be tested
 * ("a symlinked path shares the handle") without reaching into module state.
 * Nothing in production reads this; if a diagnostic ever needs it, promote it.
 */
export function openConnectionCount(): number {
  return connections.size
}

/**
 * Open (or share) a read-only handle to OpenCode's database.
 *
 * Throws an `OpencodeStoreError` whose `code` the caller turns into a
 * diagnostic: the durable channel is disabled, never guessed at.
 */
export function openOpencodeStore(dbPath: string): OpencodeStore {
  let key: string
  let identity: FileIdentity
  try {
    key = realpathSync(dbPath)
    identity = statSync(key, { bigint: true })
  } catch (error) {
    throw new OpencodeStoreError('open_failed', `OpenCode database not found at ${dbPath}`, error)
  }
  let entry = registry.get(key)
  // WHY path plus device/inode: replacing opencode.db does not revoke old
  // leases. Sharing by path alone handed a host reopening after replacement
  // the unlinked database forever while another pane retained a lease (R1-F10).
  // New opens select a new generation; old handles keep their own connection
  // until their final release. A symlink alias still shares the current file.
  if (!entry || !sameFile(entry.identity, identity)) {
    let db: SqliteDatabase
    try {
      const { DatabaseSync } = loadSqlite()
      db = new DatabaseSync(key, { readOnly: true })
    } catch (error) {
      if (error instanceof SqliteUnavailableError) throw new OpencodeStoreError('sqlite_unavailable', error.message, error)
      throw new OpencodeStoreError('open_failed', `Could not open OpenCode database read-only: ${error instanceof Error ? error.message : String(error)}`, error)
    }
    // WHY the schema gate and statement preparation share one guard: the gate
    // is only a promise that every statement will prepare, and a promise can
    // have a hole. When it had one (a since-deleted child-session statement
    // sorted on `session.time_created`, which the gate never listed; review
    // R1-F3), preparing threw a raw `ERR_SQLITE_ERROR` out of this function
    // and leaked the connection: the caller saw `open_failed` with no mention
    // of the schema, and Agent Code, which deliberately does not cache a
    // failed open, opened one more never-closed connection on every history
    // call. Inside the guard, a statement that cannot prepare means exactly
    // what a failed gate means.
    //
    // WHY BUSY is still translated rather than reported as a schema mismatch:
    // the gate is the first read on a new connection, so it is where a
    // transient BUSY (a writer recovering the WAL) lands. Calling that
    // `unsupported_schema` would tell the caller to stop for good, when
    // retrying a moment later succeeds.
    //
    // Invariant: whatever is thrown from here, `db` is closed first. Nothing
    // outside this block holds a reference to it until the registry does.
    let statements: Statements
    try {
      const schema = checkSchema(db)
      if (!schema.ok) throw new OpencodeStoreError('unsupported_schema', `OpenCode database schema is not supported: ${schema.reason}`)
      statements = prepareStatements(db)
      // Refuse an open that straddled another replacement rather than tag a
      // connection with an identity observed before it opened a different file.
      // The caller can retry; the old registry entry remains untouched.
      if (!sameFile(identity, statSync(key, { bigint: true }))) {
        throw new OpencodeStoreError('open_failed', 'OpenCode database was replaced while opening; retry the open')
      }
    } catch (error) {
      try { db.close() } catch { /* already closed */ }
      if (error instanceof OpencodeStoreError) throw error
      const translated = translate(error, 'OpenCode schema check')
      if (translated instanceof OpencodeStoreError && translated.code === 'busy') throw translated
      throw new OpencodeStoreError('unsupported_schema', `OpenCode database schema is not supported: ${error instanceof Error ? error.message : String(error)}`, error)
    }
    entry = { db, statements, refs: 0, depth: 0, identity }
    registry.set(key, entry)
    connections.add(entry)
  }
  entry.refs += 1
  return new Handle(dbPath, key, entry)
}
