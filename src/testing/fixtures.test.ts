import { describe, expect, it } from 'vitest'

import { listDurableFixtures, listLiveFixtures, loadDurableFixture, loadLiveFixture } from './fixtures.js'

// These tests guard the corpus itself, not the reader. A fixture that is not
// self-consistent would make every reader test built on it meaningless: the
// reader could be "right" against a recording that OpenCode never produced.

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function without(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

describe('durable fixtures', () => {
  const names = listDurableFixtures()

  it('exist, so reader tests cannot silently run against an empty corpus', () => {
    expect(names.length).toBeGreaterThanOrEqual(5)
  })

  for (const name of names) {
    it(`${name}: the event log replays to its own projection (census invariant 7)`, () => {
      const fixture = loadDurableFixture(name)
      const infos = new Map<string, Record<string, unknown>>()
      const parts = new Map<string, Record<string, unknown>>()
      fixture.events.forEach((event, index) => {
        // Invariant 1 on the recorded slice: gapless from 0.
        expect(event.seq).toBe(index)
        if (event.type === 'message.updated.1') {
          const info = event.data.info as Record<string, unknown>
          infos.set(String(info.id), info)
        } else if (event.type === 'message.part.updated.1') {
          const part = event.data.part as Record<string, unknown>
          parts.set(String(part.id), part)
        } else if (event.type === 'message.removed.1') {
          infos.delete(String(event.data.messageID))
        }
      })
      let compared = 0
      for (const row of fixture.messages) {
        const replayed = infos.get(row.id)
        // Messages imported before the log started never appear in it; the
        // census counts them as the "imported prefix" shape.
        if (!replayed) continue
        expect(stable(without(replayed, ['id', 'sessionID']))).toBe(stable(row.data))
        compared += 1
      }
      for (const row of fixture.parts) {
        const replayed = parts.get(row.id)
        if (!replayed) continue
        expect(stable(without(replayed, ['id', 'sessionID', 'messageID']))).toBe(stable(row.data))
      }
      expect(compared).toBeGreaterThan(0)
    })
  }
})

describe('live fixtures', () => {
  const names = listLiveFixtures()

  it('cover the scenarios the live reader is specified against', () => {
    for (const scenario of ['plain', 'permission-once', 'permission-reject', 'question-reject', 'queued']) {
      expect(names).toContain(`${scenario}.json`)
    }
  })

  for (const name of names.filter(n => n !== 'port-conflict.json')) {
    it(`${name}: durable rows are ordered and the turn has a status span`, () => {
      const fixture = loadLiveFixture(name)
      const own = fixture.durable.filter(row => row.aggregateID === fixture.sessionID)
      own.forEach((row, index) => {
        if (index > 0) expect(row.seq).toBe(own[index - 1]!.seq + 1)
      })
      const statuses = fixture.sse
        .filter(({ event }) => event.type === 'session.status' && event.properties?.sessionID === fixture.sessionID)
        .map(({ event }) => (event.properties?.status as { type: string }).type)
      expect(statuses).toContain('busy')
      expect(statuses[statuses.length - 1]).toBe('idle')
    })
  }
})
