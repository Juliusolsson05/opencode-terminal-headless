import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LiveFixtureWriter } from '../testing/fixtureDatabase.js'
import { listDurableFixtures, loadDurableFixture, type DurableFixture } from '../testing/fixtures.js'
import { commitFacts } from '../testing/oracle.js'
import { sessionRowFor, waitUntil } from '../testing/replay.js'
import { DurableReader, type DurableReaderError } from './DurableReader.js'
import { openOpencodeStore, type OpencodeStore } from './OpencodeStore.js'
import type { OpencodeMessageRecord } from './records.js'

// What the reader does when something beside it misbehaves: a host sink that
// throws, a REAL SQLite lock (not a hand-thrown error; review R3-F4) at the
// starting cursor and during a drain, and OpenCode's own WAL checkpoint while
// the tail is open. The oracle for record sets is the recording (commitFacts);
// for the rest, the contract in DurableReader's header.

const S = 'ses_faults'
const smallest = loadDurableFixture(listDurableFixtures().map(name => ({ name, size: loadDurableFixture(name).events.length })).sort((a, b) => a.size - b.size)[0]!.name)

let dir: string
let writer: LiveFixtureWriter | null
let store: OpencodeStore | null
let reader: DurableReader | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oth-faults-'))
  writer = store = reader = null
})
afterEach(() => {
  reader?.stop()
  store?.release()
  try { writer?.unlock() } catch { /* not locked */ }
  writer?.close()
  rmSync(dir, { recursive: true, force: true })
})

function tail(opts: { onRecords?: (records: OpencodeMessageRecord[]) => void; sessionID?: string; start?: boolean } = {}) {
  const sessionID = opts.sessionID ?? S
  const emitted: OpencodeMessageRecord[] = []
  const errors: DurableReaderError[] = []
  reader = new DurableReader({
    store: store!,
    sessionID,
    onRecords: records => {
      opts.onRecords?.(records)
      emitted.push(...records)
    },
    onError: error => errors.push(error),
  })
  reader.setLiveConnected(true)
  if (opts.start !== false) reader.start(-1)
  return { emitted, errors, reader: reader!, ids: () => emitted.map(record => record.info.id) }
}

const rows = (write: (type: string, data: Record<string, unknown>) => void, sessionID = S) => {
  write('message.updated.1', { sessionID, info: { id: 'msg_u', sessionID, role: 'user', time: { created: 1 } } })
  write('message.part.updated.1', { sessionID, time: 1, part: { id: 'prt_u', messageID: 'msg_u', sessionID, type: 'text', text: 'hi' } })
  write('message.updated.1', { sessionID, info: { id: 'msg_a', sessionID, role: 'assistant', parentID: 'msg_u', time: { created: 2, completed: 3 } } })
}

describe('DurableReader beside a throwing sink', () => {
  it('keeps an undelivered batch, reports sink_failed once without escaping, and redelivers on the next drain (review R1-F4)', () => {
    writer = new LiveFixtureWriter(join(dir, 'opencode.db'), S, sessionRowFor(S))
    store = openOpencodeStore(join(dir, 'opencode.db'))
    let throwsLeft = 2
    const { emitted, errors, reader: tailing, ids } = tail({
      onRecords: () => {
        if (throwsLeft > 0) {
          throwsLeft -= 1
          throw new Error('host listener threw')
        }
      },
    })
    rows((type, data) => writer!.apply(type, data))
    // Nothing escapes, and the drain says it did not finish.
    let first!: ReturnType<DurableReader['drainNow']>
    expect(() => { first = tailing.drainNow() }).not.toThrow()
    expect(first.status).toBe('deferred')
    expect(emitted).toEqual([])
    expect(errors.map(error => [error.code, error.fatal])).toEqual([['sink_failed', false]])
    // A second failure in the same streak is not reported again…
    expect(tailing.drainNow().status).toBe('deferred')
    expect(errors).toHaveLength(1)
    // …and once the sink takes the batch, every record arrives exactly once,
    // in order, and the channel is not disabled.
    expect(tailing.drainNow()).toMatchObject({ status: 'complete' })
    expect(ids()).toEqual(['msg_u', 'msg_a'])
    writer.apply('message.updated.1', { sessionID: S, info: { id: 'msg_u2', sessionID: S, role: 'user', time: { created: 4 } } })
    writer.apply('message.part.updated.1', { sessionID: S, time: 4, part: { id: 'prt_u2', messageID: 'msg_u2', sessionID: S, type: 'text', text: 'again' } })
    tailing.drainNow()
    expect(tailing.flushPendingUsers().status).toBe('complete')
    expect(ids()).toEqual(['msg_u', 'msg_a', 'msg_u2'])
  })
})

describe('DurableReader beside a real SQLite lock', () => {
  // WHY rollback-journal mode here: see LiveFixtureWriter.setJournalMode. The
  // reader cannot tell the modes apart; SQLITE_BUSY (result code 5) is what a
  // WAL reader gets from WAL recovery or an exclusive-mode writer that got
  // there first, and neither can be staged beside an already-open reader.
  function lockedSetUp(): void {
    writer = new LiveFixtureWriter(join(dir, 'opencode.db'), S, sessionRowFor(S))
    writer.setJournalMode('delete')
    store = openOpencodeStore(join(dir, 'opencode.db'))
  }

  it('a locked drain defers but an empty flush completes; the unread prompt remains eligible after release', async () => {
    lockedSetUp()
    const { emitted, errors, reader: tailing, ids } = tail()
    rows((type, data) => writer!.apply(type, data))
    writer!.lock()
    expect(tailing.drainNow()).toEqual({ status: 'deferred', records: [] })
    // The refused drain never saw the prompt. An empty flush does no SELECT,
    // so it completes even under the lock; it must not consume the unread row.
    expect(tailing.flushPendingUsers()).toEqual({ status: 'complete', records: [] })
    expect(errors).toEqual([])
    expect(emitted).toEqual([])
    writer!.unlock()
    expect(tailing.drainNow().status).toBe('complete')
    expect(ids()).toEqual(['msg_u', 'msg_a'])
    // The reader's own retry (scheduled while busy) must not duplicate.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(ids()).toEqual(['msg_u', 'msg_a'])
    expect(errors).toEqual([])
  })

  it('a flush of an already-pending prompt retries by itself after BUSY, without another turn end', async () => {
    lockedSetUp()
    const { errors, reader: tailing, ids } = tail()
    writer!.apply('message.updated.1', { sessionID: S, info: { id: 'msg_u', role: 'user', time: { created: 1 } } })
    writer!.apply('message.part.updated.1', { sessionID: S, time: 1, part: { id: 'prt_u', messageID: 'msg_u', sessionID: S, type: 'text', text: 'unanswered' } })
    expect(tailing.drainNow().status).toBe('complete')
    writer!.lock()
    expect(tailing.flushPendingUsers()).toEqual({ status: 'deferred', records: [] })
    writer!.unlock()
    // The deferred flush owes this prompt even though the cursor is already
    // at the head and no new bus event or live turn end will arrive.
    await waitUntil(() => ids().length === 1, 2000, 'pending flush retry')
    expect(ids()).toEqual(['msg_u'])
    expect(errors).toEqual([])
  })

  it('a lock held while the reader positions is retried: the starting cursor is read after release, and nothing before it is replayed', async () => {
    lockedSetUp()
    rows((type, data) => writer!.apply(type, data))
    writer!.lock()
    const { emitted, errors, reader: tailing, ids } = tail({ start: false })
    tailing.start()
    // Not positioned: nothing may be read, least of all the whole log.
    expect(tailing.drainNow()).toEqual({ status: 'deferred', records: [] })
    writer!.unlock()
    await waitUntil(() => tailing.drainNow().status === 'complete', 2000, 'positioning after the lock')
    // Positioned at the head as of the retry: the rows written before are history's job.
    expect(emitted).toEqual([])
    writer!.apply('message.updated.1', { sessionID: S, info: { id: 'msg_b', sessionID: S, role: 'assistant', parentID: 'msg_u', time: { created: 5, completed: 6 } } })
    tailing.drainNow()
    expect(ids()).toEqual(['msg_b'])
    expect(errors).toEqual([])
  })
})

describe('DurableReader across a WAL checkpoint', () => {
  it('keeps tailing through OpenCode\'s checkpoint, holds no snapshot between reads, and history agrees afterwards', () => {
    const fixture: DurableFixture = smallest
    const sessionID = fixture.meta.sessionID
    const facts = commitFacts(fixture)
    writer = new LiveFixtureWriter(join(dir, 'opencode.db'), sessionID, fixture.session)
    store = openOpencodeStore(join(dir, 'opencode.db'))
    const { emitted, errors, reader: tailing, ids } = tail({ sessionID })
    const half = Math.floor(fixture.events.length / 2)
    for (const event of fixture.events.slice(0, half)) {
      writer.apply(event.type, event.data)
      tailing.drainNow()
    }
    // OpenCode checkpoints on open (`wal_checkpoint`) and SQLite does so on
    // its own past 1,000 pages. A reader between drains pins nothing, so the
    // checkpoint must complete in full (busy = 0) and truncate the log.
    const checkpoint = writer.checkpoint()
    expect(checkpoint.busy).toBe(0)
    expect(checkpoint.log).toBe(checkpoint.checkpointed)
    for (const event of fixture.events.slice(half)) {
      writer.apply(event.type, event.data)
      tailing.drainNow()
    }
    const flushed = tailing.flushPendingUsers()
    expect(errors).toEqual([])
    expect(new Set(ids()).size).toBe(emitted.length)
    expect(new Set(ids())).toEqual(new Set([...facts.expected, ...facts.removedAfterCommit]))
    expect(flushed.status).toBe('complete')
    const history = store.readHistory(sessionID, { limit: 10_000 })
    expect(history.records.map(record => record.info.id).sort()).toEqual(fixture.messages.map(row => row.id).sort())
  })
})
