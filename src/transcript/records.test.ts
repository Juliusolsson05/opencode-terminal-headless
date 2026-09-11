import { describe, expect, it } from 'vitest'

import { listDurableFixtures, loadDurableFixture } from '../testing/fixtures.js'
import { buildMessageRecord } from './records.js'

// Record assembly is the seam every consumer reads through. These tests pin the
// two facts consumers rely on: ids come from the row (census invariant 8 says
// `data` never carries them), and the rest of `data` passes through unchanged.

const fixture = loadDurableFixture(listDurableFixtures().find(name => name.includes('ses_47fca639')) ?? listDurableFixtures()[0]!)
const sessionID = fixture.meta.sessionID

describe('buildMessageRecord', () => {
  it('re-attaches ids from columns and keeps every data field', () => {
    const assistantRow = fixture.messages.find(row => (row.data as { role?: string }).role === 'assistant')!
    const partRows = fixture.parts.filter(part => part.message_id === assistantRow.id)
    const record = buildMessageRecord(
      sessionID,
      { id: assistantRow.id, data: JSON.stringify(assistantRow.data) },
      partRows.map(part => ({ id: part.id, data: JSON.stringify(part.data) })),
    )!
    expect(record.info.id).toBe(assistantRow.id)
    expect(record.info.sessionID).toBe(sessionID)
    expect(record.info.role).toBe('assistant')
    // Everything OpenCode stored is still there, untouched.
    for (const [key, value] of Object.entries(assistantRow.data)) {
      if (key === 'time') continue
      expect(record.info[key]).toEqual(value)
    }
    expect(record.info.time).toMatchObject(assistantRow.data.time as object)
    expect(record.parts.map(part => part.id)).toEqual(partRows.map(part => part.id))
    for (const part of record.parts) {
      expect(part.messageID).toBe(assistantRow.id)
      expect(part.sessionID).toBe(sessionID)
    }
  })

  it('skips rows that are not user or assistant messages instead of inventing a shape', () => {
    expect(buildMessageRecord(sessionID, { id: 'msg_x', data: JSON.stringify({ role: 'system' }) }, [])).toBeNull()
    expect(buildMessageRecord(sessionID, { id: 'msg_x', data: '{not json' }, [])).toBeNull()
  })

  it('drops a part whose data is unreadable but keeps the message', () => {
    const record = buildMessageRecord(
      sessionID,
      { id: 'msg_x', data: JSON.stringify({ role: 'user', time: { created: 1 } }) },
      [{ id: 'prt_a', data: '{broken' }, { id: 'prt_b', data: JSON.stringify({ type: 'text', text: 'hi' }) }],
    )!
    expect(record.parts.map(part => part.id)).toEqual(['prt_b'])
  })
})
