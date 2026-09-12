import { describe, expect, it } from 'vitest'

import { useReplayRigs, startConnected, type LogEntry, type Rig } from './testing/e2eRig.js'
import { loadLiveFixture } from './testing/fixtures.js'
import { settle, waitUntil } from './testing/replay.js'
import { openOpencodeStore, OpencodeStoreError } from './transcript/OpencodeStore.js'

// Re-sync after a (re)connect, raced against the live stream: which parts of
// a snapshot may apply, what is retried, and who owns "connected".
//
// Request payloads are the recorded ones (permission-once.json,
// question-reject.json), re-addressed to the rig's session; statuses use the
// upstream `session.status` shape. The truth each test asserts is the state
// the server actually holds, never a value the code under test produced.

const { rig } = useReplayRigs()

const recording = loadLiveFixture('plain.json')
const session = recording.sessionID
const status = (sessionID: string, type: string) => ({ type: 'session.status', properties: { sessionID, status: { type } } })
const recordedPermission = loadLiveFixture('permission-once.json').sse.find(({ event }) => event.type === 'permission.asked')!.event
const recordedQuestion = loadLiveFixture('question-reject.json').sse.find(({ event }) => event.type === 'question.asked')!.event
const permissionAsked = { type: 'permission.asked', properties: { ...recordedPermission.properties, sessionID: session } }
const questionAsked = { type: 'question.asked', properties: { ...recordedQuestion.properties, sessionID: session } }

/** Drop the stream and keep refusing reconnects until `setRefusing(false)`. */
async function disconnect(r: Rig): Promise<void> {
  const disconnects = r.log.filter(e => e.kind === 'live-state' && !e.connected).length
  r.server.setRefusing(true)
  r.server.dropStreams()
  await waitUntil(() => r.log.filter(e => e.kind === 'live-state' && !e.connected).length > disconnects, 3000, 'disconnect')
}

/** Send one bus event on the open stream and wait until the headless applied it. */
async function sendApplied(r: Rig, event: Parameters<Rig['server']['send']>[0]): Promise<void> {
  const before = r.headless.getLiveProgress().busEvents
  expect(r.server.send(event)).toBe(1)
  await waitUntil(() => r.headless.getLiveProgress().busEvents > before, 3000, `${event.type} applied`)
}

const turnsStarted = (r: Rig) => r.log.filter(e => e.kind === 'semantic' && e.event.type === 'turn_started').length

describe('OpencodeTerminalHeadless re-sync', () => {
  it('applies an idle it missed even when another session went busy while the status read was in flight', async () => {
    // R2-F3 probe 1. The bus is instance-wide (`Bus.subscribeAll`), so a
    // child or background session's status arrives mid-read all the time.
    const r = await rig(recording)
    await startConnected(r)
    await sendApplied(r, status(session, 'busy'))
    await disconnect(r)
    r.server.send(status(session, 'idle')) // the turn ends while nobody listens
    const held = r.server.holdNext('/session/status') // answers {} (idle)
    r.server.setRefusing(false)
    await held.arrived
    const resyncs = r.headless.getLiveProgress().resyncs
    await sendApplied(r, status('ses_background_other', 'busy'))
    held.release()
    await waitUntil(() => r.headless.getLiveProgress().resyncs > resyncs, 3000, 're-sync applied')
    expect(r.headless.getActivity().active).toBe(false)
    expect(r.log.filter(e => e.kind === 'semantic' && e.event.type === 'turn_completed')).toHaveLength(1)
  }, 20_000)

  it('restores a permission it missed even when a question arrived while /permission was in flight', async () => {
    // R2-F3 probe 2: one request event used to discard the whole request
    // snapshot, so the question showed and the permission never did.
    const r = await rig(recording)
    await startConnected(r)
    await disconnect(r)
    r.server.send(permissionAsked) // pending on the server, unseen by us
    const held = r.server.holdNext('/permission')
    r.server.setRefusing(false)
    await held.arrived
    const resyncs = r.headless.getLiveProgress().resyncs
    await sendApplied(r, questionAsked)
    held.release()
    await waitUntil(() => r.headless.getLiveProgress().resyncs > resyncs, 3000, 're-sync applied')
    const conditions = r.headless.getConditionSnapshot().conditions
    expect(conditions['opencode.permission']?.state).toMatchObject({ requestID: recordedPermission.properties!.id })
    expect(conditions['opencode.question']?.state).toMatchObject({ questionID: recordedQuestion.properties!.id })
  }, 20_000)

  it('re-reads a part whose endpoint failed, on the same connection, until it applies', async () => {
    const r = await rig(recording)
    await startConnected(r)
    await disconnect(r)
    r.server.send(permissionAsked) // missed while disconnected
    r.server.setFailing('/permission', true)
    r.server.setRefusing(false)
    await waitUntil(() => r.log.some(e => e.kind === 'live-state' && e.connected && (e.reason ?? '').includes('/permission')), 3000, 'incomplete re-sync reported')
    expect(r.headless.getConditionSnapshot().conditions).toEqual({})
    const streamsOpened = r.server.calls.filter(c => c.path === '/event').length
    r.server.setFailing('/permission', false)
    await waitUntil(() => r.headless.getConditionSnapshot().conditions['opencode.permission'] !== undefined, 3000, 'permission restored by the retry')
    await waitUntil(() => r.headless.getLiveProgress().reconciled, 3000, 'reconciled')
    // Recovered without a reconnect, and the reason is cleared.
    expect(r.server.calls.filter(c => c.path === '/event').length).toBe(streamsOpened)
    expect(r.log[r.log.length - 1]).toMatchObject({ kind: 'live-state', connected: true })
    expect(r.log.filter((e): e is Extract<LogEntry, { kind: 'live-state' }> => e.kind === 'live-state').at(-1)?.reason).toBeUndefined()
  }, 20_000)

  it('never reports "connected" from a re-sync released after its stream dropped, and keeps the durable poll running', async () => {
    // R2-F6. The durable open is held back until after the disconnect, so the
    // late open is what must read connectivity from the stream itself.
    let allowOpen = false
    let opened = false
    const r = await rig(recording, {
      openStore: path => {
        if (!allowOpen) throw new OpencodeStoreError('busy', 'held back by the test')
        opened = true
        return openOpencodeStore(path)
      },
    })
    await startConnected(r)
    const held = r.server.holdNext('/session/status')
    r.server.dropStreams() // reconnects, and that connection's re-sync is held
    await held.arrived
    await disconnect(r)
    const disconnectedAt = r.log.length
    held.release()
    // Negative window: the stale response is ignored whenever it lands; the
    // assertions below would see a flip to connected at any later point too.
    await settle(100)
    expect(r.headless.getLiveProgress().connected).toBe(false)
    allowOpen = true
    // The reader positions at the head when it opens; rows written before
    // that are history, not tail, so wait for the open first.
    await waitUntil(() => opened, 5000, 'late durable open')
    // With the channel down, the durable poll alone must deliver commits.
    const expected = new Set<string>()
    for (const row of recording.durable) {
      if (row.aggregateID !== session) continue
      r.writer.apply(row.type, row.data)
      const info = (row.data as { info?: { id: string; role: string; time?: { completed?: number } } }).info
      if (row.type === 'message.updated.1' && info?.role === 'assistant' && typeof info.time?.completed === 'number') expected.add(info.id)
    }
    await waitUntil(() => [...expected].every(id => r.log.some(e => e.kind === 'entry' && e.record.info.id === id)), 5000, 'durable poll delivered the answer')
    expect(r.log.slice(disconnectedAt).filter(e => e.kind === 'live-state' && e.connected)).toEqual([])
  }, 20_000)

  it('ignores a re-sync snapshot that a newer connection has already superseded', async () => {
    const r = await rig(recording)
    await startConnected(r)
    await sendApplied(r, status(session, 'busy'))

    // Connection 1's re-sync reads "busy", but its answer is held back.
    const stale = r.server.holdNext('/session/status')
    r.server.dropStreams()
    await stale.arrived
    // Connection 1 drops as well, and the turn ends while nobody listens.
    await disconnect(r)
    r.server.send(status(session, 'idle'))
    // Connection 2 re-syncs to idle and closes the turn.
    r.server.setRefusing(false)
    await waitUntil(() => !r.headless.getActivity().active, 5000, 'idle from the newer re-sync')
    const turnsBefore = turnsStarted(r)

    // Connection 1's stale "busy" finally arrives. It must not re-open the turn.
    stale.release()
    // Negative window: whenever the stale answer lands, it must change nothing.
    await settle(150)
    expect(r.headless.getActivity().active).toBe(false)
    expect(turnsStarted(r)).toBe(turnsBefore)
  }, 20_000)

  it('applies the parts of a re-sync that answered, and reports the rest as live state, not a transcript error', async () => {
    const r = await rig(recording)
    await startConnected(r)
    await sendApplied(r, status(session, 'busy'))
    // The stream drops, the turn ends unheard, and /question starts failing.
    await disconnect(r)
    r.server.send(status(session, 'idle'))
    r.server.setFailing('/question', true)
    r.server.setRefusing(false)
    // The status part still ends the turn.
    await waitUntil(() => !r.headless.getActivity().active, 5000, 'idle from a partial re-sync')
    await waitUntil(
      () => r.log.some(e => e.kind === 'live-state' && e.connected && (e.reason ?? '').startsWith('resync-incomplete') && (e.reason ?? '').includes('/question')),
      3000,
      'incomplete re-sync reported',
    )
    expect(r.log.filter(e => e.kind === 'error')).toEqual([])
    expect(r.headless.getLiveProgress().reconciled).toBe(false)
  }, 20_000)
})
