// Build real SQLite databases from Stage 0 recordings, with OpenCode's own DDL
// (testing/fixtures/schema.sql), so the durable reader is always tested
// against the schema, indexes and WAL mode it meets in production.
//
// Two builders:
// - `createProjectionDatabase` writes a fixture's final state in one go:
//   projection rows, the complete event log and the sequence head. This is the
//   "open an existing session" case.
// - `LiveFixtureWriter` starts from an empty session and applies recorded
//   events one at a time, deriving projection rows exactly the way OpenCode's
//   projectors do: event row and projection rows in one immediate transaction.
//   This is the "OpenCode is writing while we tail" case.
//
// WHY foreign keys are disabled on the writer: `session.project_id` references
// a `project` table the reader never touches and schema.sql does not include.
// The reader itself opens read-only and never depends on FK enforcement.

import { loadSqlite } from '../transcript/sqlite.js'
import { loadSchemaSql, type DurableFixture } from './fixtures.js'

// A writable view of node:sqlite for tests only. Declared on its own (not as
// an extension of the reader's SqliteDatabase) because the production type
// deliberately omits `run`: the reader has no business writing.
type WritableStatement = { run(...params: Array<string | number | null>): unknown }
type WritableDatabase = {
  prepare(sql: string): WritableStatement
  exec(sql: string): void
  close(): void
}

function openWritable(file: string): WritableDatabase {
  const { DatabaseSync } = loadSqlite()
  const Ctor = DatabaseSync as unknown as new (path: string, options: Record<string, unknown>) => WritableDatabase
  const db = new Ctor(file, { enableForeignKeyConstraints: false })
  db.exec('PRAGMA journal_mode = WAL')
  return db
}

function insertSession(db: WritableDatabase, session: Record<string, unknown>): void {
  const columns = Object.keys(session)
  const values = columns.map(column => {
    const value = session[column]
    return value === undefined ? null : (value as string | number | null)
  })
  db.prepare(`INSERT INTO session (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values)
}

export function createProjectionDatabase(fixtures: DurableFixture | readonly DurableFixture[], file: string): void {
  const list = Array.isArray(fixtures) ? fixtures : [fixtures as DurableFixture]
  const db = openWritable(file)
  try {
    db.exec(loadSchemaSql())
    db.exec('BEGIN')
    const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    const insertSequence = db.prepare('INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, ?)')
    const insertEvent = db.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)')
    for (const fixture of list) {
      const sessionID = fixture.meta.sessionID
      insertSession(db, fixture.session)
      for (const row of fixture.messages) insertMessage.run(row.id, sessionID, row.time_created, row.time_updated, JSON.stringify(row.data))
      for (const row of fixture.parts) insertPart.run(row.id, row.message_id, sessionID, row.time_created, row.time_updated, JSON.stringify(row.data))
      if (fixture.sequence) {
        insertSequence.run(fixture.sequence.aggregate_id, fixture.sequence.seq, fixture.sequence.owner_id)
        // Event ids are not part of the census extraction (nothing reads
        // them); synthesise unique ones so the PRIMARY KEY holds.
        for (const event of fixture.events) insertEvent.run(`evt_${sessionID}_${event.seq}`, sessionID, event.seq, event.type, JSON.stringify(event.data))
      }
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

function strip(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

/**
 * Applies recorded events to an initially empty session the way OpenCode's
 * projectors do, one immediate transaction per event.
 *
 * Several sessions can share the file (`addSession`, then `apply(…, id)`),
 * each with its own gapless sequence, as OpenCode keeps one aggregate per
 * session (census invariant 6).
 */
export class LiveFixtureWriter {
  private readonly db: WritableDatabase
  private readonly nextSeq = new Map<string, number>()
  private locked = false

  constructor(file: string, readonly sessionID: string, session: Record<string, unknown>) {
    this.db = openWritable(file)
    this.db.exec(loadSchemaSql())
    insertSession(this.db, { ...session, id: sessionID })
  }

  /** Another session row in the same database (a task child, another pane's session). */
  addSession(session: Record<string, unknown> & { id: string }): void {
    insertSession(this.db, session)
  }

  /**
   * Switch the file's journal mode. Only possible while no other connection
   * has the file open, so call it before the reader under test opens it.
   *
   * WHY a test would leave WAL, which OpenCode always uses: `lock()` needs
   * it. A WAL reader is only ever refused (SQLITE_BUSY) by WAL recovery or by
   * a writer that entered exclusive locking mode BEFORE the reader connected,
   * and neither can be staged beside a reader that is already positioned. In
   * rollback-journal mode an EXCLUSIVE transaction refuses readers with the
   * same SQLITE_BUSY (result code 5) that the store translates to `busy`, and
   * the reader under test cannot tell the journal modes apart. Every other
   * test stays in WAL, as production is.
   */
  setJournalMode(mode: 'wal' | 'delete'): void {
    this.db.exec(`PRAGMA journal_mode = ${mode === 'wal' ? 'WAL' : 'DELETE'}`)
  }

  /** Hold an EXCLUSIVE lock (rollback-journal mode only; see setJournalMode) until `unlock()`. */
  lock(): void {
    this.db.exec('BEGIN EXCLUSIVE')
    this.locked = true
  }

  unlock(): void {
    if (!this.locked) return
    this.locked = false
    this.db.exec('COMMIT')
  }

  /** Checkpoint and truncate the WAL, as OpenCode's own open does (`wal_checkpoint`). */
  checkpoint(): { busy: number; log: number; checkpointed: number } {
    const row = (this.db as unknown as { prepare(sql: string): { get(): Record<string, unknown> } }).prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    return { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) }
  }

  apply(type: string, data: Record<string, unknown>, sessionID: string = this.sessionID): number {
    if (this.locked) throw new Error('LiveFixtureWriter.apply while lock() is held; unlock() first')
    const seq = this.nextSeq.get(sessionID) ?? 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const now = Date.now()
      if (type === 'message.updated.1') {
        const info = data.info as Record<string, unknown>
        const created = Number((info.time as { created?: number } | undefined)?.created ?? now)
        this.db.prepare(
          'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET time_updated = excluded.time_updated, data = excluded.data',
        ).run(String(info.id), sessionID, created, now, JSON.stringify(strip(info, ['id', 'sessionID'])))
      } else if (type === 'message.part.updated.1') {
        const part = data.part as Record<string, unknown>
        this.db.prepare(
          'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET time_updated = excluded.time_updated, data = excluded.data',
        ).run(String(part.id), String(part.messageID), sessionID, now, now, JSON.stringify(strip(part, ['id', 'sessionID', 'messageID'])))
      } else if (type === 'message.part.removed.1') {
        this.db.prepare('DELETE FROM part WHERE id = ?').run(String(data.partID))
      } else if (type === 'message.removed.1') {
        this.db.prepare('DELETE FROM part WHERE message_id = ?').run(String(data.messageID))
        this.db.prepare('DELETE FROM message WHERE id = ?').run(String(data.messageID))
      }
      this.db.prepare(
        'INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?) ON CONFLICT(aggregate_id) DO UPDATE SET seq = excluded.seq',
      ).run(sessionID, seq)
      this.db.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)').run(`evt_live_${sessionID}_${seq}`, sessionID, seq, type, JSON.stringify(data))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.nextSeq.set(sessionID, seq + 1)
    return seq
  }

  close(): void {
    this.db.close()
  }
}
