// Local, minimal typing of Node's built-in `node:sqlite` module.
//
// WHY this file exists instead of `import { DatabaseSync } from 'node:sqlite'`:
// Agent Code compiles this package from source against its own `@types/node`
// (20.19 at the time of writing), which has no `node:sqlite` module
// declaration. A static import would type-check here and then break Agent
// Code's `tsc` gate. `process.getBuiltinModule` is typed in @types/node 20, so
// loading through it and casting to the few members we use keeps the package
// compiling identically in both places, with no type dependency to bump.
//
// WHY node:sqlite at all (and not better-sqlite3): it is built into every
// Node this package supports (unflagged since 22.13.0) and into Electron 43's
// Node 24.18, so the durable reader adds no native module and no rebuild step.
// The synchronous API is a feature here: a read transaction must observe the
// event cursor and the projection rows as one snapshot, and the reads are
// small indexed lookups measured in microseconds.

export type SqliteValue = string | number | bigint | null | Uint8Array

export type SqliteRow = Record<string, unknown>

export type SqliteStatement = {
  all(...params: SqliteValue[]): SqliteRow[]
  get(...params: SqliteValue[]): SqliteRow | undefined
}

export type SqliteDatabase = {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  close(): void
}

export type SqliteOpenOptions = {
  /** Always true for OpenCode's database; this package never writes it. */
  readOnly?: boolean
  open?: boolean
}

export type SqliteModule = {
  DatabaseSync: new (path: string, options?: SqliteOpenOptions) => SqliteDatabase
}

export class SqliteUnavailableError extends Error {
  readonly code = 'sqlite_unavailable'
}

/**
 * Resolve `node:sqlite`, or throw a coded error the caller can turn into a
 * "durable channel disabled" diagnostic. A missing module means a Node older
 * than the documented floor, which must degrade, never crash the host.
 */
export function loadSqlite(): SqliteModule {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
  const mod = getBuiltin?.call(process, 'node:sqlite') as Partial<SqliteModule> | undefined
  if (!mod || typeof mod.DatabaseSync !== 'function') {
    throw new SqliteUnavailableError(
      `node:sqlite is unavailable in Node ${process.versions.node}; OpenCode's durable event log needs Node >= 22.13.0`,
    )
  }
  return mod as SqliteModule
}
