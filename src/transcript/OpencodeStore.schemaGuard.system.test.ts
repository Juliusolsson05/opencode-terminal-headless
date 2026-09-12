import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { openConnectionCount, openOpencodeStore, OpencodeStoreError } from './OpencodeStore.js'
import * as schema from './schema.js'
import { loadSqlite } from './sqlite.js'

it('a statement that the schema gate missed fails as unsupported_schema and closes the unpublished connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oth-schema-guard-'))
  const file = join(dir, 'opencode.db')
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(file)
  db.close()
  // Simulate a hole in the gate, the R1-F3 failure: the real SQLite prepare
  // must fail. A missing-column fixture alone only tests checkSchema's early
  // refusal; it cannot prove the guard also contains statement preparation.
  const gate = vi.spyOn(schema, 'checkSchema').mockReturnValue({ ok: true })
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  const before = openConnectionCount()
  try {
    let failure: unknown
    try { openOpencodeStore(file) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(OpencodeStoreError)
    expect(failure).toMatchObject({ code: 'unsupported_schema', message: expect.stringContaining('schema') })
    expect(close).toHaveBeenCalledTimes(1)
    expect(openConnectionCount()).toBe(before)
  } finally {
    // Even a mutant that leaks must release the captured native receiver.
    for (const result of gate.mock.calls) {
      try { result[0].close() } catch { /* correctly closed already */ }
    }
    close.mockRestore()
    gate.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})
