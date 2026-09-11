import { describe, expect, it } from 'vitest'

import { replay, startConnected, useReplayRigs } from './testing/e2eRig.js'
import { loadLiveFixture } from './testing/fixtures.js'
import { sessionRowFor, type ReplayStep } from './testing/replay.js'

const { rig } = useReplayRigs()

describe('session-switch detection through the TUI bus and durable session store', () => {
  it('reports exactly one switch to another root, ignores child/background prompts, and keeps all channels bound', async () => {
    const r = await rig(loadLiveFixture('plain.json'))
    const bound = r.sessionID
    const other = 'ses_other_root'
    const child = 'ses_task_child'
    // No session.created bus event announces either row. Root/child identity
    // MUST come through the composition's real store lookup, not just the
    // projector's cache of sessions it learned over SSE.
    r.writer.addSession({ ...sessionRowFor(other), id: other })
    r.writer.addSession({ ...sessionRowFor(child), id: child, parent_id: bound })
    await startConnected(r)
    const user = (sessionID: string, id: string) => ({ type: 'message.updated', properties: { sessionID, info: { id, sessionID, role: 'user', time: { created: 1 } } } })
    const status = (sessionID: string, type: string) => ({ type: 'session.status', properties: { sessionID, status: { type } } })
    const send = async (...events: Array<ReturnType<typeof user> | ReturnType<typeof status>>) => {
      const steps: ReplayStep[] = events.map((event, index) => ({ kind: 'sse', event, index }))
      await replay(r, steps)
    }
    await send(user(bound, 'msg_bound'), status(bound, 'busy'))
    await send(user(child, 'msg_child'), status(child, 'busy'), status(child, 'idle'))
    expect(r.log.filter(event => event.kind === 'session-switched')).toEqual([])

    // Real rows in B must not leak into A's durable stream, even when a later
    // event for A rings its reader. The literal ids/roles/times are the oracle.
    const foreign = user(other, 'msg_foreign')
    r.writer.apply('message.updated.1', foreign.properties, other)
    r.writer.apply('message.part.updated.1', { sessionID: other, part: { id: 'prt_foreign', sessionID: other, messageID: 'msg_foreign', type: 'text', text: 'other root prompt' } }, other)
    r.writer.apply('message.updated.1', { sessionID: other, info: { id: 'msg_foreign_answer', sessionID: other, role: 'assistant', parentID: 'msg_foreign', time: { created: 2, completed: 3 } } }, other)
    await send(foreign, status(other, 'busy'), status(other, 'idle'))
    await send(
      // Compaction's automatic user message while A is busy and a later
      // rewrite of A's original prompt are background activity. Both the
      // first-sighting and busy guards must prevent a switch back to A.
      user(bound, 'msg_background_compaction'), status(bound, 'idle'), user(bound, 'msg_bound'),
      foreign,
    )
    expect(r.log.filter(event => event.kind === 'session-switched')).toEqual([{ kind: 'session-switched', from: bound, to: other }])
    expect(r.log.filter(event => event.kind === 'entry')).toEqual([])
    expect(r.log.filter(event => event.kind === 'semantic' && event.event.type === 'turn_started')).toHaveLength(1)
    expect(r.log.filter(event => event.kind === 'semantic' && event.event.type === 'turn_completed')).toHaveLength(1)
    expect(r.headless.getProviderSessionId()).toBe(bound)
    expect(r.headless.getTranscriptFile()).toBe(`opencode://session/${bound}`)
    expect(r.log.filter(event => event.kind === 'error')).toEqual([])
  })

  it('reports a throwing sequencer sink and still delivers the rest of the turn', async () => {
    const r = await rig(loadLiveFixture('plain.json'))
    await startConnected(r)
    r.headless.on('semantic', event => {
      if (event.type === 'turn_started') throw new Error('host semantic callback failed')
    })
    await replay(r, ['busy', 'idle'].map((type, index) => ({
      kind: 'sse', index, event: { type: 'session.status', properties: { sessionID: r.sessionID, status: { type } } },
    })))
    expect(r.log.filter(event => event.kind === 'error')).toEqual([{
      kind: 'error', error: { channel: 'durable', code: 'sink_failed', message: 'a session event sink threw: host semantic callback failed' },
    }])
    expect(r.log.filter(event => event.kind === 'semantic' && event.event.type === 'turn_completed')).toHaveLength(1)
    expect(r.headless.getActivity()).toEqual({ active: false, status: null })
  })
})
