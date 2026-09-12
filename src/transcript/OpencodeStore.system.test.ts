import { mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectionDatabase, LiveFixtureWriter } from '../testing/fixtureDatabase.js'
import { listDurableFixtures, loadDurableFixture, type DurableFixture } from '../testing/fixtures.js'
import { projectionRecord } from '../testing/oracle.js'
import { sessionRowFor } from '../testing/replay.js'
import { openConnectionCount, OpencodeStoreError, openOpencodeStore, type OpencodeStore } from './OpencodeStore.js'
import { REQUIRED_COLUMNS } from './schema.js'
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

type RawDb = { exec(sql: string): void; close(): void }
function rawDatabase(file: string): RawDb {
  const { DatabaseSync } = loadSqlite()
  const Ctor = DatabaseSync as unknown as new (path: string) => RawDb
  return new Ctor(file)
}

let dir: string
let writer: LiveFixtureWriter | null
let handles: OpencodeStore[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oth-store-'))
  writer = null
  handles = []
})
afterEach(() => {
  for (const handle of handles) handle.release()
  try { writer?.unlock() } catch { /* not locked */ }
  writer?.close()
  rmSync(dir, { recursive: true, force: true })
})

function open(file: string): OpencodeStore {
  const store = openOpencodeStore(file)
  handles.push(store)
  return store
}

describe('OpencodeStore', () => {
  it('pages history newest-first by window and returns each window oldest-first', () => {
    const fixture = byName('ses_a6fac922')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixture, file)
    const store = open(file)
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
  })

  it('breaks a time_created tie by id in every history window, so pages stitch without a gap or a repeat', () => {
    const file = join(dir, 'opencode.db')
    writer = new LiveFixtureWriter(file, 'ses_ties', sessionRowFor('ses_ties'))
    const message = (id: string, created: number) => writer!.apply('message.updated.1', { sessionID: 'ses_ties', info: { id, sessionID: 'ses_ties', role: 'user', time: { created } } })
    message('msg_a', 100)
    message('msg_c', 200)
    message('msg_b', 200)
    message('msg_d', 300)
    message('msg_e', 300)
    const store = open(file)
    // Windows of 2 cross both ties.
    const first = store.readHistory('ses_ties', { limit: 2 })
    expect(first).toMatchObject({ hasOlder: true })
    expect(first.records.map(record => record.info.id)).toEqual(['msg_d', 'msg_e'])
    const second = store.readHistory('ses_ties', { limit: 2, beforeMessageID: 'msg_d' })
    expect(second.records.map(record => record.info.id)).toEqual(['msg_b', 'msg_c'])
    const third = store.readHistory('ses_ties', { limit: 2, beforeMessageID: 'msg_b' })
    expect(third).toMatchObject({ hasOlder: false })
    expect(third.records.map(record => record.info.id)).toEqual(['msg_a'])
  })

  it('continues below a page anchor that OpenCode has reverted away (review R1-F6)', () => {
    const file = join(dir, 'opencode.db')
    writer = new LiveFixtureWriter(file, 'ses_hist', sessionRowFor('ses_hist'))
    // Ids minted in creation order, as Identifier.ascending does.
    for (let i = 1; i <= 6; i += 1) writer.apply('message.updated.1', { sessionID: 'ses_hist', info: { id: `msg_${i}`, sessionID: 'ses_hist', role: 'user', time: { created: 100 * i } } })
    const store = open(file)
    const newest = store.readHistory('ses_hist', { limit: 2 })
    expect(newest.records.map(record => record.info.id)).toEqual(['msg_5', 'msg_6'])
    // Revert to before msg_5: everything from it on is removed.
    writer.apply('message.removed.1', { sessionID: 'ses_hist', messageID: 'msg_6' })
    writer.apply('message.removed.1', { sessionID: 'ses_hist', messageID: 'msg_5' })
    const below = store.readHistory('ses_hist', { limit: 2, beforeMessageID: 'msg_5' })
    expect(below.records.map(record => record.info.id)).toEqual(['msg_3', 'msg_4'])
    expect(below.hasOlder).toBe(true)
    const oldest = store.readHistory('ses_hist', { limit: 2, beforeMessageID: 'msg_3' })
    expect(oldest.records.map(record => record.info.id)).toEqual(['msg_1', 'msg_2'])
    expect(oldest.hasOlder).toBe(false)
    expect(store.countMessages('ses_hist')).toBe(4)
  })

  it('counts the projection\'s messages for a session, including an imported prefix the log never saw', () => {
    const fixture = byName('ses_5a9eb743')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixture, file)
    const store = open(file)
    expect(store.countMessages(fixture.meta.sessionID)).toBe(fixture.messages.length)
    expect(store.countMessages('ses_unknown')).toBe(0)
  })

  it('walks every recorded session forward in projection order, a few messages per read', () => {
    for (const name of listDurableFixtures()) {
      const fixture = loadDurableFixture(name)
      const file = join(dir, `${fixture.meta.sessionID}.db`)
      createProjectionDatabase(fixture, file)
      const store = open(file)
      const walked = [...store.iterateMessages(fixture.meta.sessionID, { pageSize: 3 })]
      expect(walked.map(record => record.info.id), name).toEqual(projectionOrder(fixture))
      for (const record of walked) expect(record, name).toEqual(projectionRecord(fixture, record.info.id))
      expect([...store.iterateMessages('ses_unknown')]).toEqual([])
    }
  })

  it('keeps walking past a message removed between pages and includes one appended meanwhile', () => {
    const file = join(dir, 'opencode.db')
    writer = new LiveFixtureWriter(file, 'ses_walk', sessionRowFor('ses_walk'))
    const message = (id: string, created: number) =>
      writer!.apply('message.updated.1', { sessionID: 'ses_walk', info: { id, sessionID: 'ses_walk', role: 'user', time: { created } } })
    // msg_b and msg_c share a millisecond: the id breaks the tie, as in
    // history paging.
    message('msg_a', 100)
    message('msg_c', 200)
    message('msg_b', 200)
    message('msg_d', 300)
    message('msg_e', 400)
    const store = open(file)
    const walk = store.iterateMessages('ses_walk', { pageSize: 2 })
    const seen = [walk.next().value!.info.id, walk.next().value!.info.id]
    expect(seen).toEqual(['msg_a', 'msg_b'])
    // OpenCode writes while the consumer is between pages.
    writer.apply('message.removed.1', { sessionID: 'ses_walk', messageID: 'msg_c' })
    message('msg_f', 500)
    for (const record of walk) seen.push(record.info.id)
    expect(seen).toEqual(['msg_a', 'msg_b', 'msg_d', 'msg_e', 'msg_f'])
  })

  it('reports the sequence head as the tail cursor, and -1 for a session with no log', () => {
    const fixture = byName('ses_47fca639')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixture, file)
    const store = open(file)
    expect(store.cursor(fixture.meta.sessionID)).toBe(fixture.sequence!.seq)
    expect(store.cursor('ses_unknown')).toBe(-1)
  })

  it('reads payloads only for consumed event types and parses name and version', () => {
    const fixture = byName('ses_47fca639')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixture, file)
    const store = open(file)
    const events = store.read(tx => tx.eventsAfter(fixture.meta.sessionID, -1, 10_000))
    expect(events.map(event => event.seq)).toEqual(fixture.events.map(event => event.seq))
    for (const event of events) {
      expect(event.version).toBe(1)
      if (event.name === 'message.updated' || event.name === 'message.removed') expect(event.data).not.toBeNull()
      else expect(event.data).toBeNull()
    }
  })

  it('reads a session\'s parent for descendant-aware request filtering (a hand-built parent/child pair)', () => {
    const file = join(dir, 'opencode.db')
    writer = new LiveFixtureWriter(file, 'ses_parent', sessionRowFor('ses_parent'))
    // The corpus has a parent (ses_f96bdb53) and a child (ses_f963831c) of
    // DIFFERENT parents, so the pair is built by hand (review R3-F6).
    writer.addSession({ ...sessionRowFor('ses_child'), id: 'ses_child', parent_id: 'ses_parent', title: 'task child' })
    const store = open(file)
    expect(store.readSessionInfo('ses_child')).toMatchObject({ id: 'ses_child', parentID: 'ses_parent', title: 'task child', directory: '/sandbox/project' })
    expect(store.readSessionInfo('ses_parent')?.parentID).toBeNull()
    expect(store.readSessionInfo('ses_unknown')).toBeNull()
  })

  it('shares one connection per file and closes it when the last handle is released', () => {
    const fixture = byName('ses_47fca639')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixture, file)
    const before = openConnectionCount()
    const first = openOpencodeStore(file)
    const second = openOpencodeStore(file)
    try {
      expect(openConnectionCount()).toBe(before + 1)
      first.release()
      // The shared connection is still open for the remaining handle.
      expect(second.cursor(fixture.meta.sessionID)).toBe(fixture.sequence!.seq)
      second.release()
      expect(openConnectionCount()).toBe(before)
      // And a fresh open after full release works.
      const third = openOpencodeStore(file)
      expect(third.cursor(fixture.meta.sessionID)).toBe(fixture.sequence!.seq)
      third.release()
      expect(() => third.cursor(fixture.meta.sessionID)).toThrow(OpencodeStoreError)
    } finally {
      first.release()
      second.release()
    }
  })

  it('keys the shared connection by real path, so a symlinked path shares the handle', () => {
    const fixture = byName('ses_47fca639')
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixture, file)
    const link = join(dir, 'link.db')
    symlinkSync(file, link)
    const before = openConnectionCount()
    const viaPath = open(file)
    const viaLink = open(link)
    expect(openConnectionCount()).toBe(before + 1)
    expect(viaLink.dbPath).toBe(link)
    viaPath.release()
    expect(openConnectionCount()).toBe(before + 1)
    expect(viaLink.cursor(fixture.meta.sessionID)).toBe(fixture.sequence!.seq)
    viaLink.release()
    expect(openConnectionCount()).toBe(before)
  })

  it('a replacement at the same path gets a new generation while old leases remain readable (review R1-F10)', () => {
    const file = join(dir, 'opencode.db')
    const replacement = join(dir, 'replacement.db')
    const S = 'ses_replace'
    const make = (path: string, id: string) => {
      const w = new LiveFixtureWriter(path, S, sessionRowFor(S))
      try {
        // A closed, checkpointed file replacement is the host recovery case.
        // DELETE avoids pairing an old inode with a new generation's WAL name.
        w.setJournalMode('delete')
        w.apply('message.updated.1', { sessionID: S, info: { id, role: 'user', time: { created: 1 } } })
      } finally { w.close() }
    }
    make(file, 'msg_old')
    const before = openConnectionCount()
    const held = open(file)
    const host = open(file)
    host.release()
    make(replacement, 'msg_new')
    renameSync(replacement, file)
    const reopened = open(file)
    expect(reopened.readHistory(S).records.map(record => record.info.id)).toEqual(['msg_new'])
    expect(held.readHistory(S).records.map(record => record.info.id)).toEqual(['msg_old'])
    expect(openConnectionCount()).toBe(before + 2)
    held.release()
    expect(openConnectionCount()).toBe(before + 1)
    // Releasing the last OLD lease must not evict the NEW registry entry.
    const shared = open(file)
    expect(openConnectionCount()).toBe(before + 1)
    expect(shared.readHistory(S).records.map(record => record.info.id)).toEqual(['msg_new'])
    reopened.release()
    shared.release()
    expect(openConnectionCount()).toBe(before)
  })

  it('opens a database that has exactly the columns the gate lists, and every read runs on it (the gate covers every statement; review R1-F3)', () => {
    const file = join(dir, 'opencode.db')
    const db = rawDatabase(file)
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) db.exec(`CREATE TABLE "${table}" (${columns.map(column => `"${column}"`).join(', ')})`)
    db.exec(`INSERT INTO session VALUES ('ses_min', NULL, '/p', 'minimal', 5, 1)`)
    db.exec(`INSERT INTO message VALUES ('msg_1', 'ses_min', 1, '${JSON.stringify({ role: 'user', time: { created: 1 } })}')`)
    db.exec(`INSERT INTO message VALUES ('msg_2', 'ses_min', 2, '${JSON.stringify({ role: 'assistant', parentID: 'msg_1', time: { created: 2, completed: 3 } })}')`)
    db.exec(`INSERT INTO part VALUES ('prt_1', 'msg_1', '${JSON.stringify({ type: 'text', text: 'hi' })}')`)
    db.exec(`INSERT INTO event VALUES ('ses_min', 0, 'message.updated.1', '${JSON.stringify({ info: { id: 'msg_1', role: 'user', time: { created: 1 } } })}')`)
    db.exec(`INSERT INTO event_sequence VALUES ('ses_min', 0)`)
    db.close()
    const store = open(file)
    expect(store.listSessions({ directory: '/p', limit: 5 })).toEqual([{ id: 'ses_min', title: 'minimal', directory: '/p', timeUpdated: 5, timeCreated: 1 }])
    expect(store.cursor('ses_min')).toBe(0)
    expect(store.read(tx => tx.historyMessageIDs('ses_min')).sort()).toEqual(['msg_1', 'msg_2'])
    expect(store.read(tx => tx.eventsAfter('ses_min', -1, 10)).map(event => event.name)).toEqual(['message.updated'])
    expect(store.read(tx => tx.loadMessage('ses_min', 'msg_1'))?.parts.map(part => part.id)).toEqual(['prt_1'])
    expect(store.readHistory('ses_min', { limit: 1 })).toMatchObject({ hasOlder: true })
    expect(store.readHistory('ses_min', { limit: 1, beforeMessageID: 'msg_2' }).records.map(record => record.info.id)).toEqual(['msg_1'])
    expect(store.readHistory('ses_min', { limit: 1, beforeMessageID: 'msg_gone' }).records.map(record => record.info.id)).toEqual(['msg_2'])
    expect(store.countMessages('ses_min')).toBe(2)
    expect([...store.iterateMessages('ses_min', { pageSize: 1 })].map(record => record.info.id)).toEqual(['msg_1', 'msg_2'])
    // This database has ONLY the gate's columns, so it has no `agent`/`model`.
    // That is a supported state, not a refusal: those two feed the prompt's
    // agent/model preservation alone, and listing them in the gate would take
    // every transcript in the database down with them on a build that lacks
    // them. The contract is an unknown selection — exactly how prompting
    // behaved before the store read them at all.
    expect(store.readSessionInfo('ses_min')).toEqual({
      id: 'ses_min', parentID: null, directory: '/p', title: 'minimal', timeUpdated: 5,
      selection: { agent: null, providerID: null, modelID: null, variant: null },
    })
  })

  it('refuses a database missing a table the reader needs (fail closed)', () => {
    const file = join(dir, 'opencode.db')
    const db = rawDatabase(file)
    db.exec('CREATE TABLE session (id text, parent_id text, directory text, title text, time_updated integer, time_created integer)')
    db.exec('CREATE TABLE message (id text, session_id text, time_created integer, data text)')
    db.exec('CREATE TABLE part (id text, message_id text, data text)')
    db.exec('CREATE TABLE event (aggregate_id text, type text, data text)') // no seq
    db.exec('CREATE TABLE event_sequence (aggregate_id text, seq integer)')
    db.close()
    const before = openConnectionCount()
    let caught: unknown
    try {
      openOpencodeStore(file)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OpencodeStoreError)
    expect((caught as OpencodeStoreError).code).toBe('unsupported_schema')
    expect((caught as OpencodeStoreError).message).toContain('event')
    // A refused open leaks no connection.
    expect(openConnectionCount()).toBe(before)
  })

  it('translates a real SQLite lock at the first read to `busy` (result code 5), and reads normally after release', () => {
    const fixture = byName('ses_47fca639')
    const file = join(dir, 'opencode.db')
    writer = new LiveFixtureWriter(file, fixture.meta.sessionID, fixture.session)
    // See LiveFixtureWriter.setJournalMode for why the lock needs this mode.
    writer.setJournalMode('delete')
    for (const event of fixture.events) writer.apply(event.type, event.data)
    const store = open(file)
    writer.lock()
    let caught: unknown
    try {
      store.cursor(fixture.meta.sessionID)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OpencodeStoreError)
    expect((caught as OpencodeStoreError).code).toBe('busy')
    expect(((caught as OpencodeStoreError).cause as { errcode?: number }).errcode).toBe(5)
    writer.unlock()
    expect(store.cursor(fixture.meta.sessionID)).toBe(fixture.events.length - 1)
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
