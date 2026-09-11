// Schema gate: refuse to read an OpenCode database whose shape this reader was
// not built against.
//
// WHY a gate and not best-effort reads: OpenCode's database is private and
// still moving (1.18 already carries `session_message`/`session_input` tables
// for a future layout). A reader that silently adapts to a changed schema
// produces plausible-but-wrong transcripts; a reader that refuses produces a
// diagnostic and today's behavior. Only the second is safe for status and MCP
// consumers that act on what they read.
//
// The expected columns are the ones the prepared statements in OpencodeStore
// use — nothing more. Extra columns (OpenCode adds them in migrations) are fine;
// a missing one is not.

import type { SqliteDatabase } from './sqlite.js'

export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session: ['id', 'parent_id', 'directory', 'title', 'time_updated'],
  message: ['id', 'session_id', 'time_created', 'data'],
  part: ['id', 'message_id', 'data'],
  event: ['aggregate_id', 'seq', 'type', 'data'],
  event_sequence: ['aggregate_id', 'seq'],
}

export type SchemaCheck = { ok: true } | { ok: false; reason: string }

export function checkSchema(db: SqliteDatabase): SchemaCheck {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    // PRAGMA table_info returns zero rows for a missing table, so one query
    // answers both "table exists" and "columns exist".
    const present = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => String(row.name)))
    if (present.size === 0) return { ok: false, reason: `table ${table} is missing` }
    const missing = columns.filter(column => !present.has(column))
    if (missing.length > 0) return { ok: false, reason: `table ${table} is missing column(s) ${missing.join(', ')}` }
  }
  return { ok: true }
}
