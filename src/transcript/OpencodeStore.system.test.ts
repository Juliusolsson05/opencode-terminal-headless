import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectionDatabase, LiveFixtureWriter } from '../testing/fixtureDatabase.js'
import { listDurableFixtures, loadDurableFixture, type DurableFixture } from '../testing/fixtures.js'
import { projectionRecord } from '../testing/oracle.js'
import { sessionRowFor } from '../testing/replay.js'
import { OpencodeStoreError, openOpencodeStore } from './OpencodeStore.js'
import { loadSqlite } from './sqlite.js'

// These run against real SQLite files built with OpenCode's own DDL, written
// by a separate writable connection and then closed — the state a parked
// agent's history read meets when no OpenCode process is running.

function byName(fragment: string): DurableFixture {
  const name = listDurableFixtures().find(candidate => candidate.includes(fragment))
  if (!name) throw new Error(`missing fixture ${fragment}`)
  return loadDurableFixture(name)
}

function projectionOrder(fixture: DurableFixture): string[] {
  return [...fixture.messages]
    .sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(row => row.id)
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oth-store-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('OpencodeStore', () => {
  it('pages history newest-first by window and returns each window oldest-first', () => {
    const fixture = byName('ses_a6fac922')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixture, file)
    const store = openOpencodeStore(file)
    try {
      const expected = projectionOrder(fixture)
      const collected: string[] = []
      let before: string | undefined
      for (;;) {
        const page = store.readHistory(fixture.meta.sessionID, { limit: 2, beforeMessageID: before })
        collected.unshift(...page.records.map(record => record.info.id))
        if (!page.hasOlder) break
        before = page.records[0]!.info.id
      }
      expect(collected).toEqual(expected)
      for (const id of collected) {
        const page = store.readHistory(fixture.meta.sessionID, { limit: 1000 })
        expect(page.records.find(record => record.info.id === id)).toEqual(projectionRecord(fixture, id))
      }
    } finally {
      store.release()
    }
  })

  it('counts the projection\'s messages for a session, including an imported prefix the log never saw', () => {
    const fixture = byName('ses_5a9eb743')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixture, file)
    const store = openOpencodeStore(file)
    try {
      expect(store.countMessages(fixture.meta.sessionID)).toBe(fixture.messages.length)
      expect(store.countMessages('ses_unknown')).toBe(0)
    } finally {
      store.release()
    }
  })

  it('walks every recorded session forward in projection order, a few messages per read', () => {
    for (const name of listDurableFixtures()) {
      const fixture = loadDurableFixture(name)
      const file = join(dir, `${fixture.meta.sessionID}.db`)
      createProjectionDatabase(fixture, file)
      const store = openOpencodeStore(file)
      try {
        const walked = [...store.iterateMessages(fixture.meta.sessionID, { pageSize: 3 })]
        expect(walked.map(record => record.info.id), name).toEqual(projectionOrder(fixture))
        for (const record of walked) expect(record, name).toEqual(projectionRecord(fixture, record.info.id))
        expect([...store.iterateMessages('ses_unknown')]).toEqual([])
      } finally {
        store.release()
      }
    }
  })

  it('keeps walking past a message removed between pages and includes one appended meanwhile', () => {
    const file = join(dir, 'opencode.db')
    const writer = new LiveFixtureWriter(file, 'ses_walk', sessionRowFor('ses_walk'))
    const message = (id: string, created: number) =>
      writer.apply('message.updated.1', { sessionID: 'ses_walk', info: { id, sessionID: 'ses_walk', role: 'user', time: { created } } })
    // msg_b and msg_c share a millisecond: the id breaks the tie, as in
    // history paging.
    message('msg_a', 100)
    message('msg_c', 200)
    message('msg_b', 200)
    message('msg_d', 300)
    message('msg_e', 400)
    const store = openOpencodeStore(file)
    try {
      const walk = store.iterateMessages('ses_walk', { pageSize: 2 })
      const seen = [walk.next().value!.info.id, walk.next().value!.info.id]
      expect(seen).toEqual(['msg_a', 'msg_b'])
      // OpenCode writes while the consumer is between pages.
      writer.apply('message.removed.1', { sessionID: 'ses_walk', messageID: 'msg_c' })
      message('msg_f', 500)
      for (const record of walk) seen.push(record.info.id)
      expect(seen).toEqual(['msg_a', 'msg_b', 'msg_d', 'msg_e', 'msg_f'])
    } finally {
      store.release()
      writer.close()
    }
  })

  it('reports the sequence head as the tail cursor, and -1 for a session with no log', () => {
    const fixture = byName('ses_47fca639')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixture, file)
    const store = openOpencodeStore(file)
    try {
      expect(store.cursor(fixture.meta.sessionID)).toBe(fixture.sequence!.seq)
      expect(store.cursor('ses_unknown')).toBe(-1)
    } finally {
      store.release()
    }
  })

  it('reads payloads only for consumed event types and parses name and version', () => {
    const fixture = byName('ses_47fca639')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixture, file)
    const store = openOpencodeStore(file)
    try {
      const events = store.read(tx => tx.eventsAfter(fixture.meta.sessionID, -1, 10_000))
      expect(events.map(event => event.seq)).toEqual(fixture.events.map(event => event.seq))
      for (const event of events) {
        expect(event.version).toBe(1)
        if (event.name === 'message.updated' || event.name === 'message.removed') expect(event.data).not.toBeNull()
        else expect(event.data).toBeNull()
      }
    } finally {
      store.release()
    }
  })

  it('finds child sessions for descendant-aware request filtering', () => {
    const parent = byName('ses_f96bdb53')
    const child = byName('ses_f963831c')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase([parent, child], file)
    const store = openOpencodeStore(file)
    try {
      if (child.meta.parentID === parent.meta.sessionID) {
        expect(store.readChildSessionIDs(parent.meta.sessionID)).toContain(child.meta.sessionID)
      }
      expect(store.readSessionInfo(child.meta.sessionID)?.parentID).toBe(child.meta.parentID)
      expect(store.readSessionInfo('ses_unknown')).toBeNull()
    } finally {
      store.release()
    }
  })

  it('shares one connection per file and closes it when the last handle is released', () => {
    const fixture = byName('ses_47fca639')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixture, file)
    const first = openOpencodeStore(file)
    const second = openOpencodeStore(file)
    first.release()
    // The shared connection is still open for the remaining handle.
    expect(second.cursor(fixture.meta.sessionID)).toBe(fixture.sequence!.seq)
    second.release()
    // And a fresh open after full release works.
    const third = openOpencodeStore(file)
    expect(third.cursor(fixture.meta.sessionID)).toBe(fixture.sequence!.seq)
    third.release()
    expect(() => third.cursor(fixture.meta.sessionID)).toThrow(OpencodeStoreError)
  })

  it('refuses a database missing a table the reader needs (fail closed)', () => {
    const file = join(dir, 'opencode.db')
    const { DatabaseSync } = loadSqlite()
    const Ctor = DatabaseSync as unknown as new (path: string) => { exec(sql: string): void; close(): void }
    const db = new Ctor(file)
    db.exec('CREATE TABLE session (id text, parent_id text, directory text, title text, time_updated integer)')
    db.exec('CREATE TABLE message (id text, session_id text, time_created integer, data text)')
    db.exec('CREATE TABLE part (id text, message_id text, data text)')
    db.exec('CREATE TABLE event (aggregate_id text, type text, data text)') // no seq
    db.exec('CREATE TABLE event_sequence (aggregate_id text, seq integer)')
    db.close()
    let caught: unknown
    try {
      openOpencodeStore(file)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OpencodeStoreError)
    expect((caught as OpencodeStoreError).code).toBe('unsupported_schema')
    expect((caught as OpencodeStoreError).message).toContain('event')
  })

  it('reports a missing database as open_failed rather than creating one', () => {
    let caught: unknown
    try {
      openOpencodeStore(join(dir, 'absent.db'))
    } catch (error) {
      caught = error
    }
    expect((caught as OpencodeStoreError).code).toBe('open_failed')
  })
})
