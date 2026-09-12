// WHY fingerprint the replay DDL artifact: tests reconstruct this schema, so
// changing it without reviewing the recordings must fail corpus validation.
// This is not OpenCode's internal migration number. Snapshot the source DDL
// before capturing a new corpus; see testing/fixtures/README.md.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function fixtureMeta(recordedWith: string): { recordedWith: string; schemaVersion: string } {
  return {
    recordedWith,
    schemaVersion: `sha256:${createHash('sha256').update(readFileSync(new URL('../../testing/fixtures/schema.sql', import.meta.url))).digest('hex')}`,
  }
}
