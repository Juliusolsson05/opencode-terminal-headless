import { describe, expect, it } from 'vitest'

import { listDurableFixtures, loadDurableFixture } from '../testing/fixtures.js'
import { buildMessageRecord } from './records.js'

// Record assembly is the seam every consumer reads through. These tests pin the
// facts consumers rely on, field by field against the fixture rows themselves
// (not against another record builder): ids come from the row (census
// invariant 8 says `data` never carries them), and the rest of `data`, of the
// message and of every part, passes through unchanged. Together with the
// hand-written oracle in src/testing/oracle.ts this is what keeps a symmetric
// assembly bug from blessing itself (review R3-F7); keep both.

const sessionRows = listDurableFixtures().map(name => ({ name, fixture: loadDurableFixture(name) }))

describe('buildMessageRecord over every recorded message', () => {
  for (const { name, fixture } of sessionRows) {
    const sessionID = fixture.meta.sessionID

    it(`${name}: every user and assistant row keeps its data and gets its ids from the columns`, () => {
      const roles = new Set<string>()
      for (const row of fixture.messages) {
        const role = (row.data as { role?: string }).role
        const record = buildMessageRecord(sessionID, { id: row.id, data: JSON.stringify(row.data) }, [])
        if (role !== 'user' && role !== 'assistant') {
          expect(record, row.id).toBeNull()
          continue
        }
        roles.add(role)
        expect(record!.info.id).toBe(row.id)
        expect(record!.info.sessionID).toBe(sessionID)
        expect(record!.info.role).toBe(role)
        // Everything OpenCode stored is still there, untouched.
        for (const [key, value] of Object.entries(row.data)) expect(record!.info[key], `${row.id}.${key}`).toEqual(value)
      }
      // The corpus exercises both roles in every session, so neither path is vacuous.
      expect([...roles].sort()).toEqual(['assistant', 'user'])
    })

    it(`${name}: every part keeps type, text, tool and state, in id order, with its ids from the columns`, () => {
      let tools = 0
      for (const row of fixture.messages) {
        const partRows = fixture.parts.filter(part => part.message_id === row.id)
        // Rows in the order the store's statement returns them (ORDER BY id).
        const ordered = [...partRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const record = buildMessageRecord(
          sessionID,
          { id: row.id, data: JSON.stringify(row.data) },
          ordered.map(part => ({ id: part.id, data: JSON.stringify(part.data) })),
        )
        if (!record) continue
        expect(record.parts.map(part => part.id)).toEqual(ordered.map(part => part.id))
        record.parts.forEach((part, index) => {
          const source = ordered[index]!.data as Record<string, unknown>
          expect(part.messageID).toBe(row.id)
          expect(part.sessionID).toBe(sessionID)
          expect(part.type).toBe(source.type)
          expect(part.text).toEqual(source.text)
          expect(part.tool).toEqual(source.tool)
          expect(part.state).toEqual(source.state)
          if (source.type === 'tool') tools += 1
          for (const [key, value] of Object.entries(source)) expect(part[key], `${part.id}.${key}`).toEqual(value)
        })
      }
      // Every fixture but one carries tool calls (its flags say so); the one
      // without must not make the tool assertions above silently vacuous.
      expect(tools > 0).toBe(fixture.meta.flags.toolCalls === true)
    })
  }
})

describe('buildMessageRecord contract', () => {
  const sessionID = 'ses_contract'

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

  it('never lets a stray id inside data override the column (census invariant 8)', () => {
    const record = buildMessageRecord(
      sessionID,
      { id: 'msg_col', data: JSON.stringify({ id: 'msg_data', sessionID: 'ses_data', role: 'assistant', time: { created: 5, completed: 9 } }) },
      [{ id: 'prt_col', data: JSON.stringify({ id: 'prt_data', messageID: 'msg_data', sessionID: 'ses_data', type: 'text', text: 'x' }) }],
    )!
    expect(record.info).toMatchObject({ id: 'msg_col', sessionID, role: 'assistant', time: { created: 5, completed: 9 } })
    expect(record.parts[0]).toMatchObject({ id: 'prt_col', messageID: 'msg_col', sessionID, type: 'text', text: 'x' })
  })
})
