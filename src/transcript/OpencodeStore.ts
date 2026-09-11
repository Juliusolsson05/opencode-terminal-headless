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

import { realpathSync } from 'node:fs'

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
// version it understands. Every other type is scanned for its name only.
export const CONSUMED_EVENT_TYPES: Readonly<Record<string, number>> = {
  'message.updated': 1,
  'message.removed': 1,
}

// Types OpenCode 1.18.x writes that the reader deliberately ignores. Listed so
// an unfamiliar name can be told apart from a familiar one (research doc).
export const KNOWN_IGNORED_EVENT_NAMES: ReadonlySet<string> = new Set([
  'message.part.updated',
  'message.part.removed',
  'session.created',
  'session.updated',
  'session.deleted',
])

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
}

export type HistoryPage = { records: OpencodeMessageRecord[]; hasOlder: boolean }

export type OpencodeReadTransaction = {
  cursor(sessionID: string): number
  eventsAfter(sessionID: string, afterSeq: number, limit: number): DurableEvent[]
  loadMessage(sessionID: string, messageID: string): OpencodeMessageRecord | null
}

export type OpencodeStore = {
  readonly dbPath: string
  read<T>(fn: (tx: OpencodeReadTransaction) => T): T
  cursor(sessionID: string): number
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
  readChildSessionIDs(sessionID: string): string[]
  release(): void
}

type Statements = {
  cursor: SqliteStatement
  events: SqliteStatement
  message: SqliteStatement
  parts: SqliteStatement
  historyNewest: SqliteStatement
  historyAnchor: SqliteStatement
  historyBefore: SqliteStatement
  forwardAfter: SqliteStatement
  session: SqliteStatement
  children: SqliteStatement
  count: SqliteStatement
}

type Entry = { db: SqliteDatabase; statements: Statements; refs: number; depth: number }

const registry = new Map<string, Entry>()

const consumedTypeList = Object.entries(CONSUMED_EVENT_TYPES)
  .map(([name, version]) => `'${name}.${version}'`)
  .join(', ')

function prepareStatements(db: SqliteDatabase): Statements {
  return {
    cursor: db.prepare('SELECT seq FROM event_sequence WHERE aggregate_id = ?'),
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
    // The same (time_created, id) order as history, walked forward from a
    // key rather than a message id, so a message removed between pages cannot
    // strand the walk (see iterateMessages).
    forwardAfter: db.prepare(
      `SELECT id, time_created FROM message WHERE session_id = ? AND (time_created > ? OR (time_created = ? AND id > ?))
       ORDER BY time_created, id LIMIT ?`,
    ),
    session: db.prepare('SELECT id, parent_id, directory, title, time_updated FROM session WHERE id = ?'),
    children: db.prepare('SELECT id FROM session WHERE parent_id = ? ORDER BY time_created'),
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
        if (!anchor) return { records: [], hasOlder: false }
        const created = Number(anchor.time_created) as SqliteValue
        rows = statements.historyBefore.all(sessionID, created, created, opts.beforeMessageID, limit + 1)
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
      }
    })
  }

  readChildSessionIDs(sessionID: string): string[] {
    return this.read(() => this.entry.statements.children.all(sessionID).map(row => String(row.id)))
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.entry.refs -= 1
    if (this.entry.refs === 0) {
      registry.delete(this.key)
      try { this.entry.db.close() } catch { /* already closed */ }
    }
  }
}

/**
 * Open (or share) a read-only handle to OpenCode's database.
 *
 * Throws an `OpencodeStoreError` whose `code` the caller turns into a
 * diagnostic: the durable channel is disabled, never guessed at.
 */
export function openOpencodeStore(dbPath: string): OpencodeStore {
  let key: string
  try {
    key = realpathSync(dbPath)
  } catch (error) {
    throw new OpencodeStoreError('open_failed', `OpenCode database not found at ${dbPath}`, error)
  }
  let entry = registry.get(key)
  if (!entry) {
    let db: SqliteDatabase
    try {
      const { DatabaseSync } = loadSqlite()
      db = new DatabaseSync(key, { readOnly: true })
    } catch (error) {
      if (error instanceof SqliteUnavailableError) throw new OpencodeStoreError('sqlite_unavailable', error.message, error)
      throw new OpencodeStoreError('open_failed', `Could not open OpenCode database read-only: ${error instanceof Error ? error.message : String(error)}`, error)
    }
    // WHY SQLite errors here are translated, not reported as a schema
    // mismatch: the schema check is the first read on a new connection, so
    // it is where a transient BUSY (a writer recovering the WAL) lands. Calling
    // that `unsupported_schema` told the caller to stop for good, when
    // retrying a moment later succeeds.
    let schema: ReturnType<typeof checkSchema>
    try {
      schema = checkSchema(db)
    } catch (error) {
      try { db.close() } catch { /* ignore */ }
      const translated = translate(error, 'OpenCode schema check')
      if (translated instanceof OpencodeStoreError) throw translated
      throw new OpencodeStoreError('unsupported_schema', `OpenCode database schema is not supported: ${error instanceof Error ? error.message : String(error)}`, error)
    }
    if (!schema.ok) {
      try { db.close() } catch { /* ignore */ }
      throw new OpencodeStoreError('unsupported_schema', `OpenCode database schema is not supported: ${schema.reason}`)
    }
    entry = { db, statements: prepareStatements(db), refs: 0, depth: 0 }
    registry.set(key, entry)
  }
  entry.refs += 1
  return new Handle(dbPath, key, entry)
}
