import { describe, expect, it } from 'vitest'

import type { SemanticEvent } from './channels/types.js'
import { useReplayRigs, startConnected, statusSpans, expectedCommits, indexOfKind, REPLAYABLE_RECORDINGS, type LogEntry } from './testing/e2eRig.js'
import { loadLiveFixture } from './testing/fixtures.js'
import { buildReplayScript, playReplay, settle, waitUntil } from './testing/replay.js'

// Every live recording re-enacted end to end: status, turns, committed
// messages, conditions and the order they reach the host.
//
// Every expectation is derived from the recording itself (its status spans,
// its durable rows, its request ids), never from the code under test. The
// rig and oracles are shared in src/testing/e2eRig.ts.

const { rig } = useReplayRigs()

describe('OpencodeTerminalHeadless replaying recorded TUI sessions end to end', () => {
  for (const name of REPLAYABLE_RECORDINGS) {
    it(`${name}: status, turns, committed messages, conditions and their order`, async () => {
      const recording = loadLiveFixture(name)
      const r = await rig(recording)
      await startConnected(r)
      await playReplay(buildReplayScript(recording), r.writer, r.server)
      await waitUntil(() => !r.headless.getActivity().active, 3000, 'final idle')
      await settle(60)

      expect(r.log.filter(e => e.kind === 'error')).toEqual([])

      // Committed messages: exactly the committable ones, each once, with the
      // pane's transcript locator on the committed channel.
      const entries = r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record)
      const ids = entries.map(record => record.info.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(new Set(ids)).toEqual(expectedCommits(recording).ids)
      expect(new Set(r.committedFiles)).toEqual(new Set([`opencode://session/${recording.sessionID}`]))
      expect(entries.every(record => record.info.sessionID === recording.sessionID)).toBe(true)

      // Turns: one per recorded busy→idle span, paired and never overlapping.
      const semantic = r.log.filter((e): e is Extract<LogEntry, { kind: 'semantic' }> => e.kind === 'semantic').map(e => e.event)
      const starts = semantic.filter(e => e.type === 'turn_started')
      const completes = semantic.filter(e => e.type === 'turn_completed')
      expect(starts).toHaveLength(statusSpans(recording))
      expect(completes.map(e => e.turnId)).toEqual(starts.map(e => e.turnId))

      // Activity: busy inside every turn, idle at the end, never idle mid-turn.
      let inTurn = false
      for (const entry of r.log) {
        if (entry.kind === 'semantic' && entry.event.type === 'turn_started') inTurn = true
        if (entry.kind === 'semantic' && entry.event.type === 'turn_completed') inTurn = false
        if (entry.kind === 'activity' && inTurn) expect(entry.active).toBe(true)
      }
      const activity = r.log.filter((e): e is Extract<LogEntry, { kind: 'activity' }> => e.kind === 'activity')
      expect(activity[0]?.active).toBe(true)
      expect(activity[activity.length - 1]?.active).toBe(false)

      // The order Agent Code's orchestration depends on, per turn: the turn's
      // committed answer, then turn_completed, then phase idle, then inactive.
      for (const complete of completes) {
        const completeAt = indexOfKind(r.log, e => e.kind === 'semantic' && e.event === complete)
        const startAt = indexOfKind(r.log, e => e.kind === 'semantic' && e.event.type === 'turn_started' && e.event.turnId === complete.turnId)
        const answersInTurn = r.log
          .map((e, i) => ({ e, i }))
          .filter(({ e, i }) => i > startAt && i < completeAt && e.kind === 'entry' && e.record.info.role === 'assistant')
        expect(answersInTurn.length).toBeGreaterThan(0)
        const idleAt = indexOfKind(r.log, e => e.kind === 'semantic' && e.event.type === 'stream_phase' && e.event.phase === 'idle', completeAt)
        const inactiveAt = indexOfKind(r.log, e => e.kind === 'activity' && !e.active, idleAt)
        expect(idleAt).toBeGreaterThan(completeAt)
        expect(inactiveAt).toBeGreaterThan(idleAt)
        // The completed turn carries the answer the user saw.
        const lastAnswer = (answersInTurn[answersInTurn.length - 1]!.e as Extract<LogEntry, { kind: 'entry' }>).record
        const lastText = lastAnswer.parts.filter(p => p.type === 'text').map(p => String(p.text)).join('')
        if (lastText) expect((complete as Extract<SemanticEvent, { type: 'turn_completed' }>).fullText).toBe(lastText)
      }

      // Conditions: the first snapshot is the explicit empty one; recorded
      // requests surface with their ids and clear again.
      const snapshots = r.log.filter((e): e is Extract<LogEntry, { kind: 'conditions' }> => e.kind === 'conditions').map(e => e.snapshot)
      expect(snapshots[0]?.conditions).toEqual({})
      expect(snapshots[snapshots.length - 1]?.conditions).toEqual({})
      const asked = recording.sse.find(({ event }) => event.type === 'permission.asked' || event.type === 'question.asked')?.event
      if (asked) {
        const kind = asked.type === 'permission.asked' ? 'opencode.permission' : 'opencode.question'
        const idKey = kind === 'opencode.permission' ? 'requestID' : 'questionID'
        const visible = snapshots.find(s => s.conditions[kind])
        expect((visible!.conditions[kind]!.state as Record<string, unknown>)[idKey]).toBe(asked.properties?.id)
      } else {
        expect(snapshots.every(s => Object.keys(s.conditions).length === 0)).toBe(true)
      }
    })
  }
})
