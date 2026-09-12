// Test-only loaders for the Stage 0 recordings (excluded from the build by
// tsconfig.build.json). Every durable/live test reads fixtures through here so
// the on-disk shape is declared once, next to the code that depends on it.
//
// WHY recordings and not hand-written literals: the reader's rules were
// derived from what OpenCode actually wrote (research/census-2026-09-10.md).
// A literal typed into a test encodes the author's belief about that shape;
// a recording encodes the shape itself.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// WHY this does not simply call fileURLToPath(import.meta.url): hosts run the
// replay harness from DOM-emulating test projects (Agent Code's renderer tests
// under happy-dom), and Vite's web transform rewrites `import.meta.url` there
// to an http URL whose path is either `/@fs/<absolute path>` or relative to the
// project root. Node's file APIs still work in those environments; only the URL
// form differs, so the loader accepts all three shapes.
function resolveFixtureRoot(): string {
  const here = new URL('../../testing/fixtures/', import.meta.url)
  if (here.protocol === 'file:') return fileURLToPath(here)
  const pathname = decodeURIComponent(here.pathname)
  const candidates = pathname.startsWith('/@fs/')
    ? [pathname.slice('/@fs'.length)]
    : [pathname, join(process.cwd(), pathname)]
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) throw new Error(`cannot locate opencode-terminal-headless fixtures from ${here.href}`)
  return found.endsWith('/') ? found : `${found}/`
}

const FIXTURE_ROOT = resolveFixtureRoot()

export type DurableFixtureRow = { seq: number; type: string; data: Record<string, unknown> }
export type ProjectionMessageRow = { id: string; time_created: number; time_updated: number; data: Record<string, unknown> }
export type ProjectionPartRow = { id: string; message_id: string; time_created: number; time_updated: number; data: Record<string, unknown> }

// recordedWith is the observed CLI at capture, not session.version (which
// may be an import stamp). schemaVersion fingerprints the replay DDL artifact.
export type FixtureMetadata = { recordedWith: string; schemaVersion: string }

export type DurableFixture = {
  meta: FixtureMetadata & { sessionVersion: string | null; sessionID: string; parentID: string | null; opencodeVersion: string | null; flags: Record<string, boolean> }
  session: Record<string, unknown>
  sequence: { aggregate_id: string; seq: number; owner_id: string | null } | null
  events: DurableFixtureRow[]
  messages: ProjectionMessageRow[]
  parts: ProjectionPartRow[]
}

export type LiveFixture = {
  meta: FixtureMetadata
  scenario: string
  opencodeVersion: string
  sessionID: string
  notes: string[]
  sse: Array<{ t: number; event: { id?: string; type: string; properties?: Record<string, unknown> } }>
  durable: Array<{ t: number; rowid: number; aggregateID: string; seq: number; type: string; data: Record<string, unknown> }>
  http: Array<{ t: number; method: string; path: string; auth: boolean; status: number; body: unknown }>
  prompts: Array<{ t: number; text: string }>
  pty: { firstOutputAt: number | null; bytes: number; exit: { exitCode: number; signal?: number; t: number } | null; tail: string }
}

export function fixturePath(relative: string): string {
  return `${FIXTURE_ROOT}${relative}`
}

export function listDurableFixtures(): string[] {
  return readdirSync(fixturePath('durable')).filter(name => name.endsWith('.json')).sort()
}

export function loadDurableFixture(name: string): DurableFixture {
  return JSON.parse(readFileSync(fixturePath(`durable/${name}`), 'utf8')) as DurableFixture
}

export function listLiveFixtures(): string[] {
  return readdirSync(fixturePath('live')).filter(name => name.endsWith('.json')).sort()
}

export function loadLiveFixture(name: string): LiveFixture {
  return JSON.parse(readFileSync(fixturePath(`live/${name}`), 'utf8')) as LiveFixture
}

export function loadSchemaSql(): string {
  return readFileSync(fixturePath('schema.sql'), 'utf8')
}
