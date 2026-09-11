import { describe, expect, it } from 'vitest'

import { listLiveFixtures, loadLiveFixture, type LiveFixture } from '../testing/fixtures.js'
import { LiveStateProjector } from './LiveStateProjector.js'
import type { LiveBusEvent, LiveOutput } from './types.js'

// Each recording is a real OpenCode 1.18.30 TUI session. Expectations are read
// off the recording's own `session.status` events — never off the projector —
// so the tests check the projector against what OpenCode actually did.

const RECORDINGS = listLiveFixtures().filter(name => name !== 'port-conflict.json')

function statusSpans(fixture: LiveFixture): number {
  let spans = 0
  let busy = false
  for (const { event } of fixture.sse) {
    if (event.properties?.sessionID !== fixture.sessionID) continue
    if (event.type === 'session.status') {
      const type = (event.properties.status as { type?: string } | undefined)?.type
      if ((type === 'busy' || type === 'retry') && !busy) { busy = true; spans += 1 }
      if (type === 'idle') busy = false
    }
    if (event.type === 'session.idle') busy = false
  }
  return spans
}

function run(fixture: LiveFixture): Array<{ output: LiveOutput; after: LiveBusEvent }> {
  const projector = new LiveStateProjector(fixture.sessionID, { now: () => 1_000 })
  const out: Array<{ output: LiveOutput; after: LiveBusEvent }> = []
  for (const { event } of fixture.sse) for (const output of projector.apply(event)) out.push({ output, after: event })
  return out
}

describe('LiveStateProjector over recorded TUI sessions', () => {
  for (const name of RECORDINGS) {
    const fixture = loadLiveFixture(name)
    const outputs = run(fixture)
    const kinds = outputs.map(entry => entry.output)

    it(`${name}: one turn per recorded busy→idle span, never overlapping`, () => {
      const starts = kinds.filter((o): o is Extract<LiveOutput, { kind: 'turn-start' }> => o.kind === 'turn-start')
      const ends = kinds.filter((o): o is Extract<LiveOutput, { kind: 'turn-end' }> => o.kind === 'turn-end')
      expect(starts.length).toBe(statusSpans(fixture))
      expect(ends.length).toBe(starts.length)
      let open: string | null = null
      for (const output of kinds) {
        if (output.kind === 'turn-start') { expect(open).toBeNull(); open = output.turnId }
        if (output.kind === 'turn-end') { expect(output.turnId).toBe(open); open = null }
      }
      expect(open).toBeNull()
    })

    it(`${name}: never reports inactive inside a turn (multi-step and queued turns stay busy)`, () => {
      let inTurn = false
      for (const output of kinds) {
        if (output.kind === 'turn-start') inTurn = true
        if (output.kind === 'activity' && inTurn) {
          const endingNow = !output.active
          // The only inactive activity allowed is the one emitted with turn-end.
          if (endingNow) expect(kinds[kinds.indexOf(output) - 2]?.kind).toBe('turn-end')
        }
        if (output.kind === 'turn-end') inTurn = false
      }
    })

    it(`${name}: phases stay within the renderer vocabulary and end idle`, () => {
      const phases = kinds.filter((o): o is Extract<LiveOutput, { kind: 'phase' }> => o.kind === 'phase').map(o => o.phase)
      for (const phase of phases) expect(['requesting', 'thinking', 'responding', 'tool-use', 'idle']).toContain(phase)
      expect(phases[phases.length - 1]).toBe('idle')
    })

    it(`${name}: asks the durable reader to drain before every turn end`, () => {
      kinds.forEach((output, index) => {
        if (output.kind === 'turn-end') expect(kinds[index - 1]?.kind).toBe('durable-hint')
      })
    })

    it(`${name}: a single-session run never looks like a session switch`, () => {
      expect(kinds.filter(output => output.kind === 'session-switched')).toEqual([])
    })
  }

  it('surfaces a recorded permission request from asked until replied, titled from its verb and patterns', () => {
    for (const name of ['permission-once.json', 'permission-reject.json']) {
      const fixture = loadLiveFixture(name)
      const asked = fixture.sse.find(({ event }) => event.type === 'permission.asked')!.event
      const requests = run(fixture).filter(entry => entry.output.kind === 'requests')
      const first = requests[0]!.output as Extract<LiveOutput, { kind: 'requests' }>
      expect(requests[0]!.after.type).toBe('permission.asked')
      expect(first.permission?.requestID).toBe(asked.properties?.id)
      expect(first.permission?.title).toBe(`bash: ${(asked.properties?.patterns as string[]).join(', ')}`)
      const cleared = requests[1]!.output as Extract<LiveOutput, { kind: 'requests' }>
      expect(requests[1]!.after.type).toBe('permission.replied')
      expect(cleared.permission).toBeNull()
    }
  })

  it('surfaces a recorded question from asked until rejected', () => {
    const fixture = loadLiveFixture('question-reject.json')
    const requests = run(fixture).filter(entry => entry.output.kind === 'requests')
    expect(requests.map(entry => entry.after.type)).toEqual(['question.asked', 'question.rejected'])
    const first = requests[0]!.output as Extract<LiveOutput, { kind: 'requests' }>
    expect(first.question?.text.length).toBeGreaterThan(0)
    expect((requests[1]!.output as Extract<LiveOutput, { kind: 'requests' }>).question).toBeNull()
  })

  it('keeps a different session\'s status, turns and requests out, and reports only that the TUI now drives it', () => {
    // Seen from a pane bound to another session, this recording is the TUI
    // prompting a root session (its `session.updated` carries no parentID)
    // that is not the pane's: exactly the session-switch signal, and nothing
    // else of that session may leak into the pane.
    const fixture = loadLiveFixture('permission-once.json')
    const projector = new LiveStateProjector('ses_someone_else')
    const outputs = fixture.sse.flatMap(({ event }) => projector.apply(event))
    expect(outputs).toEqual([{ kind: 'session-switched', from: 'ses_someone_else', to: fixture.sessionID }])
  })

  it('keeps requests from a descendant session learned from session.created', () => {
    const fixture = loadLiveFixture('permission-once.json')
    const asked = fixture.sse.find(({ event }) => event.type === 'permission.asked')!.event
    const projector = new LiveStateProjector(fixture.sessionID)
    projector.apply({ type: 'session.created', properties: { sessionID: 'ses_child', info: { id: 'ses_child', parentID: fixture.sessionID } } })
    const outputs = projector.apply({ ...asked, properties: { ...asked.properties, sessionID: 'ses_child' } })
    expect(outputs).toHaveLength(1)
    expect((outputs[0] as Extract<LiveOutput, { kind: 'requests' }>).permission?.sessionID).toBe('ses_child')
  })

  it('re-syncs from the recorded endpoint responses after a reconnect', () => {
    const fixture = loadLiveFixture('permission-once.json')
    const pendingBody = fixture.http.find(h => h.path === '/permission' && Array.isArray(h.body) && (h.body as unknown[]).length > 0)!.body as unknown[]
    const busyBody = fixture.http.find(h => h.path === '/session/status' && h.auth && JSON.stringify(h.body) !== '{}')!.body as Record<string, { type: string }>
    const projector = new LiveStateProjector(fixture.sessionID)
    const reconnect = projector.resync({ status: busyBody, permissions: pendingBody, questions: [] })
    expect(reconnect.map(o => o.kind)).toEqual(['turn-start', 'phase', 'activity', 'requests'])
    // The server reports idle ({}) on the next reconnect: the missed idle ends the turn.
    const later = projector.resync({ status: {}, permissions: [], questions: [] })
    expect(later.map(o => o.kind)).toEqual(['durable-hint', 'turn-end', 'phase', 'activity', 'requests'])
  })
})
