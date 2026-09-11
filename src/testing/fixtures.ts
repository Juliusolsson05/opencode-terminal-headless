// Test-only loaders for the Stage 0 recordings (excluded from the build by
// tsconfig.build.json). Every durable/live test reads fixtures through here so
// the on-disk shape is declared once, next to the code that depends on it.
//
// WHY recordings and not hand-written literals: the reader's rules were
// derived from what OpenCode actually wrote (research/census-2026-09-10.md).
// A literal typed into a test encodes the author's belief about that shape;
// a recording encodes the shape itself.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURE_ROOT = fileURLToPath(new URL('../../testing/fixtures/', import.meta.url))

export type DurableFixtureRow = { seq: number; type: string; data: Record<string, unknown> }
export type ProjectionMessageRow = { id: string; time_created: number; time_updated: number; data: Record<string, unknown> }
export type ProjectionPartRow = { id: string; message_id: string; time_created: number; time_updated: number; data: Record<string, unknown> }

export type DurableFixture = {
  meta: { sessionID: string; parentID: string | null; opencodeVersion: string | null; flags: Record<string, boolean> }
  session: Record<string, unknown>
  sequence: { aggregate_id: string; seq: number; owner_id: string | null } | null
  events: DurableFixtureRow[]
  messages: ProjectionMessageRow[]
  parts: ProjectionPartRow[]
}

export type LiveFixture = {
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
