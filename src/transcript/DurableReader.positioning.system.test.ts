import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it } from 'vitest'

import { LiveFixtureWriter } from '../testing/fixtureDatabase.js'
import { loadLiveFixture } from '../testing/fixtures.js'
import { sessionRowFor } from '../testing/replay.js'
import { DurableReader, type DurableReaderError } from './DurableReader.js'
import { openOpencodeStore, type OpencodeStore } from './OpencodeStore.js'
import type { OpencodeMessageRecord } from './records.js'

let dir: string
let writer: LiveFixtureWriter | undefined
let store: OpencodeStore | undefined
let reader: DurableReader | undefined
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oth-position-')) })
afterEach(() => {
  reader?.stop()
  store?.release()
  writer?.close()
  reader = undefined
  store = undefined
  writer = undefined
  rmSync(dir, { recursive: true, force: true })
})

function position(sessionID: string) {
  store = openOpencodeStore(join(dir, 'opencode.db'))
  const records: OpencodeMessageRecord[] = []
  const errors: DurableReaderError[] = []
  reader = new DurableReader({ store, sessionID, onRecords: batch => records.push(...batch), onError: error => errors.push(error) })
  reader.setLiveConnected(true)
  reader.start()
  return { records, errors, reader }
}

it('positioning after plain seq 1 keeps the old prompt in history when seq 6 and 16 rewrite its summary', () => {
  const fixture = loadLiveFixture('plain.json')
  writer = new LiveFixtureWriter(join(dir, 'opencode.db'), fixture.sessionID, sessionRowFor(fixture.sessionID))
  const rows = fixture.durable.filter(row => row.aggregateID === fixture.sessionID)
  for (const row of rows.filter(row => row.seq <= 1)) writer.apply(row.type, row.data)
  const { records, errors, reader: tail } = position(fixture.sessionID)
  expect(tail.getCursor()).toBe(1)
  // The fixture (not another reader) identifies the prompt that history owns.
  const prompt = rows.find(row => (row.data.info as { role?: string })?.role === 'user')!.data.info as { id: string }
  expect(store!.readHistory(fixture.sessionID).records.map(record => record.info.id)).toEqual([prompt.id])
  for (const row of rows.filter(row => row.seq > 1)) {
    writer.apply(row.type, row.data)
    expect(tail.drainNow().status).toBe('complete')
  }
  tail.flushPendingUsers()
  const completedIDs = rows.filter(row => {
    const info = row.data.info as { role?: string; time?: { completed?: number } } | undefined
    return info?.role === 'assistant' && typeof info.time?.completed === 'number'
  }).map(row => (row.data.info as { id: string }).id)
  expect(completedIDs.length).toBeGreaterThan(0)
  expect(records.map(record => record.info.id)).toEqual([...new Set(completedIDs)])
  expect(records.some(record => record.info.id === prompt.id)).toBe(false)
  expect(errors).toEqual([])
})

it('history owns completed assistants but an assistant still incomplete at positioning remains eligible', () => {
  const S = 'ses_position'
  writer = new LiveFixtureWriter(join(dir, 'opencode.db'), S, sessionRowFor(S))
  const write = (info: Record<string, unknown>) => writer!.apply('message.updated.1', { sessionID: S, info: { sessionID: S, ...info } })
  const done = { id: 'msg_done', role: 'assistant', parentID: 'msg_user', time: { created: 2, completed: 3 } }
  const open = { id: 'msg_open', role: 'assistant', parentID: 'msg_user', time: { created: 4 } }
  write({ id: 'msg_user', role: 'user', time: { created: 1 } })
  write(done)
  write(open)
  const { records, errors, reader: tail } = position(S)
  write({ ...done, summary: true })
  write({ ...open, time: { created: 4, completed: 5 } })
  tail.drainNow()
  tail.flushPendingUsers()
  expect(records.map(record => record.info.id)).toEqual(['msg_open'])
  expect(errors).toEqual([])
})
