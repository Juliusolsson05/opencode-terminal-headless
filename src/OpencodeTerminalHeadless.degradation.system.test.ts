import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { allocateLoopbackPort } from './launch/port.js'
import { useReplayRigs, startConnected, expectedCommits, indexOfKind, replay, type LogEntry } from './testing/e2eRig.js'
import { loadLiveFixture } from './testing/fixtures.js'
import { buildReplayScript, settle, waitUntil } from './testing/replay.js'
import { openOpencodeStore, OpencodeStoreError } from './transcript/OpencodeStore.js'
import { loadSqlite } from './transcript/sqlite.js'

// Losing a channel, or part of one, without reporting wrong data: dropped
// streams, an unreachable or foreign server, a refused or busy database.
// Re-sync races have their own file (OpencodeTerminalHeadless.resync).
//
// Every expectation is derived from the recording itself (its status spans,
// its durable rows, its request ids, its notes and PTY exit), never from the
// code under test. The rig and oracles are shared in src/testing/e2eRig.ts.

const { rig, dir } = useReplayRigs()

describe('OpencodeTerminalHeadless degrading honestly', () => {
  it('ends a turn that finished while the stream was down, via re-sync, with the answer first', async () => {
    const recording = loadLiveFixture('plain.json')
    const r = await rig(recording)
    await startConnected(r)
    let dropped = false
    await replay(r, buildReplayScript(recording), {
      beforeStep: async step => {
        // Drop the stream once the turn has visibly started (the prompt's own
        // parts arrive BEFORE busy, so waiting on the turn_started event — not
        // on some part — is what makes "mid-turn" true). The rest of the turn,
        // including its idle, then happens while nobody is listening.
        if (!dropped && step.kind === 'sse' && r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_started')) {
          dropped = true
          r.server.setRefusing(true)
          r.server.dropStreams()
          await waitUntil(() => r.log.some(e => e.kind === 'live-state' && !e.connected), 3000, 'disconnect')
        }
      },
    })
    expect(dropped).toBe(true)
    expect(r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_completed')).toBe(false)
    // While disconnected the pane must still read as busy: the turn is open.
    expect(r.headless.getActivity().active).toBe(true)
    r.server.setRefusing(false)
    await waitUntil(() => r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_completed'), 5000, 'turn end after re-sync')
    await waitUntil(() => r.headless.getLiveProgress().reconciled, 5000, 're-sync applied')
    const completeAt = indexOfKind(r.log, e => e.kind === 'semantic' && e.event.type === 'turn_completed')
    const answerAt = indexOfKind(r.log, e => e.kind === 'entry' && e.record.info.role === 'assistant')
    expect(answerAt).toBeGreaterThanOrEqual(0)
    expect(answerAt).toBeLessThan(completeAt)
    expect(r.headless.getActivity().active).toBe(false)
    const ids = r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id)
    expect(new Set(ids)).toEqual(expectedCommits(recording).ids)
    // WHY a longer budget: this test waits for a real disconnect, replays a
    // turn nobody hears, then waits for a real reconnect and re-sync — three
    // bounded waits whose sum exceeds the 5 s default.
  }, 20_000)

  it('delivers a turn that happened entirely while disconnected, without leaving the pane busy', async () => {
    // Found by the replays: a prompt's own parts reach the bus BEFORE busy, so
    // a stream lost at that moment misses the whole turn. The durable poll must
    // still deliver the conversation, and re-sync must not invent a turn.
    const recording = loadLiveFixture('plain.json')
    const r = await rig(recording)
    await startConnected(r)
    let dropped = false
    await replay(r, buildReplayScript(recording), {
      beforeStep: async step => {
        if (!dropped && step.kind === 'sse' && step.event.type === 'message.updated') {
          dropped = true
          r.server.setRefusing(true)
          r.server.dropStreams()
          await waitUntil(() => r.log.some(e => e.kind === 'live-state' && !e.connected), 3000, 'disconnect')
        }
      },
    })
    const expected = expectedCommits(recording).ids
    const committed = () => new Set(r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id))
    await waitUntil(() => committed().size === expected.size, 3000, 'durable poll while disconnected')
    const resyncs = r.headless.getLiveProgress().resyncs
    r.server.setRefusing(false)
    // The reconnect's re-sync has applied: its verdict is final from here.
    await waitUntil(() => r.headless.getLiveProgress().resyncs > resyncs && r.headless.getLiveProgress().reconciled, 5000, 're-sync after reconnect')
    expect(committed()).toEqual(expected)
    expect(r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_started')).toBe(false)
    expect(r.headless.getActivity().active).toBe(false)
  }, 20_000)

  it('reports server-unreachable after the deadline and still commits from the durable log', async () => {
    const recording = loadLiveFixture('plain.json')
    const closedPort = await allocateLoopbackPort()
    const r = await rig(recording, { url: `http://127.0.0.1:${closedPort}`, deadlineMs: 300 })
    await r.headless.start()
    await waitUntil(() => r.log.some(e => e.kind === 'live-state' && e.reason === 'server-unreachable'), 3000, 'unreachable')
    for (const step of buildReplayScript(recording)) if (step.kind === 'durable') r.writer.apply(step.row.type, step.row.data)
    // Prompts commit when their answer appears and answers on completion, so
    // the durable poll alone delivers the whole conversation.
    const expected = expectedCommits(recording).ids
    const committed = () => new Set(r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id))
    await waitUntil(() => committed().size === expected.size, 3000, 'durable poll')
    expect(committed()).toEqual(expected)
    // Without the live channel there is no status source at all: honest idle.
    expect(r.log.some(e => e.kind === 'activity' && e.active)).toBe(false)
  })

  it('replays port-conflict.json: a foreign process on the port, reported unreachable, then the recorded SIGTERM exit', async () => {
    // The recording: the TUI never served (0 SSE events, 0 durable rows, 0
    // PTY bytes), the contested port answered 418 to every request (the
    // probe's blocker), and the TUI was finally killed: exit code 0, signal 15.
    const recording = loadLiveFixture('port-conflict.json')
    expect(recording.sse).toEqual([])
    expect(recording.notes.some(note => note.includes('answered 418'))).toBe(true)
    const r = await rig(recording, { deadlineMs: 300 })
    r.server.setBlocking(true)
    await r.headless.start()
    await waitUntil(() => r.log.some(e => e.kind === 'live-state' && e.reason === 'server-unreachable'), 3000, 'unreachable')
    // The live channel really tried, and met the blocker.
    expect(r.server.calls.some(c => c.path === '/event')).toBe(true)
    expect(r.log.filter(e => e.kind === 'activity')).toEqual([])
    expect(r.log.filter(e => e.kind === 'semantic')).toEqual([])
    expect(r.log.filter(e => e.kind === 'error')).toEqual([])
    const exit = recording.pty.exit!
    r.pty.exit(exit.exitCode, exit.signal)
    await waitUntil(() => r.log.some(e => e.kind === 'exit'), 3000, 'exit reported')
    const before = r.log.length
    // Negative window: nothing may follow the exit, however late.
    await settle(60)
    expect(r.log.length).toBe(before)
    expect(r.log.filter(e => e.kind === 'exit')).toEqual([{ kind: 'exit', exitCode: 0, signal: 15 }])
    expect(r.log[r.log.length - 1]).toEqual({ kind: 'exit', exitCode: 0, signal: 15 })
  })

  it('never connects with the wrong password, and says so', async () => {
    const r = await rig(loadLiveFixture('plain.json'), { password: 'not-the-password', deadlineMs: 300 })
    await r.headless.start()
    await waitUntil(() => r.log.some(e => e.kind === 'live-state' && e.reason === 'server-unreachable'), 3000, 'unreachable')
    expect(r.server.calls.length).toBeGreaterThan(0)
    expect(r.server.calls.every(c => !c.authorized)).toBe(true)
  })

  it('disables only the durable channel for a database it refuses', async () => {
    const recording = loadLiveFixture('plain.json')
    const foreign = join(dir(), 'foreign.db')
    const { DatabaseSync } = loadSqlite()
    const db = new (DatabaseSync as unknown as new (p: string) => { exec(s: string): void; close(): void })(foreign)
    db.exec('CREATE TABLE unrelated (x integer)')
    db.close()
    const r = await rig(recording, { dbPath: foreign })
    await startConnected(r)
    await replay(r, buildReplayScript(recording))
    await waitUntil(() => r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_completed'), 3000, 'turn end')
    const errors = r.log.filter((e): e is Extract<LogEntry, { kind: 'error' }> => e.kind === 'error').map(e => e.error)
    expect(errors).toEqual([expect.objectContaining({ channel: 'durable', code: 'unsupported_schema' })])
    expect(r.log.some(e => e.kind === 'entry')).toBe(false)
    expect(r.log.some(e => e.kind === 'activity' && e.active)).toBe(true)
  })

  it('retries a database that is busy at open instead of disabling the durable channel', async () => {
    const recording = loadLiveFixture('plain.json')
    // Two opens meet a writer recovering the WAL; the third gets through.
    let refusals = 2
    let opened = false
    const r = await rig(recording, {
      openStore: path => {
        if (refusals > 0) {
          refusals -= 1
          throw new OpencodeStoreError('busy', 'OpenCode schema check: database busy')
        }
        opened = true
        return openOpencodeStore(path)
      },
    })
    await startConnected(r)
    await waitUntil(() => opened, 3000, 'durable open retried')
    await replay(r, buildReplayScript(recording))
    await waitUntil(() => r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_completed'), 5000, 'turn end')
    await waitUntil(() => !r.headless.getActivity().active, 3000, 'final idle')
    expect(r.log.filter(e => e.kind === 'error')).toEqual([])
    const ids = r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id)
    expect(new Set(ids)).toEqual(expectedCommits(recording).ids)
    // The answer still precedes the turn's end, as with a healthy open.
    const completeAt = indexOfKind(r.log, e => e.kind === 'semantic' && e.event.type === 'turn_completed')
    expect(indexOfKind(r.log, e => e.kind === 'entry' && e.record.info.role === 'assistant')).toBeLessThan(completeAt)
  })

  it('reports a missing database path instead of guessing one', async () => {
    const r = await rig(loadLiveFixture('plain.json'), { dbPath: null })
    await r.headless.start()
    expect(r.log.find(e => e.kind === 'error')).toMatchObject({ error: { channel: 'durable', code: 'db_path_unavailable' } })
    // A host that passed no resolver must be told the truth: this is permanent
    // for this pane. Promising a background retry here survived mutation until
    // this assertion existed (review R2-M12), and it is the sentence a
    // resolver-less host shows its users.
    const message = r.log.find((e): e is Extract<LogEntry, { kind: 'error' }> => e.kind === 'error')?.error.message ?? ''
    expect(message).not.toContain('Retrying in the background')
  })

  // #1114. The recorded failure was `opencode db path` overrunning its 20 s
  // budget during a multi-pane restore and being killed — a busy machine, not a
  // broken OpenCode. Because this branch used to `return`, that one moment cost
  // the pane its committed stream until the app was restarted. These pin the
  // recovery on the real path: a real SQLite file, a real replay, and the
  // recording's own rows as the oracle.
  // agent-code#1114, the launch no longer waits for `opencode db path`. The
  // lookup runs beside the TUI and the durable channel opens when it lands.
  it('opens the durable channel once the launch\'s pending lookup lands, with no diagnostic before it', async () => {
    const recording = loadLiveFixture('plain.json')
    let release!: () => void
    const r = await rig(recording, {
      dbPathPending: path => new Promise<string>(resolve => { release = () => resolve(path) }),
    })
    await startConnected(r)
    // A normal cold lookup takes 0.4-2 s. It must not flash "retrying".
    await settle()
    expect(r.log.filter(e => e.kind === 'error')).toEqual([])
    release()
    await settle()
    await replay(r, buildReplayScript(recording))
    await waitUntil(() => r.log.filter(e => e.kind === 'entry').length >= expectedCommits(recording).ids.size, 3000, 'committed rows')
    expect(new Set(r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id))).toEqual(expectedCommits(recording).ids)
    expect(r.log.filter(e => e.kind === 'error')).toEqual([])
  })

  // The window the old order closed by construction: once the TUI has painted
  // it can take input, so rows committed before the reader positions may be
  // behind its starting head. That is reported, and the host re-reads
  // history. The ordering source is the TUI's first output, not a message
  // time (steering q94).
  it('reports a possible gap when the TUI painted before the pending lookup landed', async () => {
    const recording = loadLiveFixture('plain.json')
    let release!: () => void
    const r = await rig(recording, {
      dbPathPending: path => new Promise<string>(resolve => { release = () => resolve(path) }),
    })
    await startConnected(r)
    r.pty.output()
    await replay(r, buildReplayScript(recording))
    release()
    await waitUntil(() => r.log.some(e => e.kind === 'error' && e.error.code === 'db_path_recovered_late'), 3000, 'late-open report')
    const errors = r.log.filter((e): e is Extract<LogEntry, { kind: 'error' }> => e.kind === 'error')
    expect(errors.map(e => e.error.code)).toEqual(['db_path_recovered_late'])
    expect(errors[0]?.error.message).toContain('could take input before the database path was known after launch')
  })

  // #10 verification a/b: the time check was fooled by (1) a message created
  // before launch and completed inside the window, and (2) a clock that
  // stepped backwards. Neither matters now: a launch clock set AFTER every
  // recorded row (the backward-step shape, and a pre-launch creation time for
  // every message) still reports, because the TUI had painted.
  it('reports regardless of message creation times (pre-launch messages, backward clock)', async () => {
    const recording = loadLiveFixture('plain.json')
    let release!: () => void
    const r = await rig(recording, {
      now: () => Number.MAX_SAFE_INTEGER,
      dbPathPending: path => new Promise<string>(resolve => { release = () => resolve(path) }),
    })
    await startConnected(r)
    r.pty.output()
    await replay(r, buildReplayScript(recording))
    release()
    await waitUntil(() => r.log.some(e => e.kind === 'error' && e.error.code === 'db_path_recovered_late'), 3000, 'late-open report')
  })

  // #10 review B2: a turn that ran and finished before `/event` came up left no
  // live trace at all. The first output still says the TUI could take input.
  it('reports a turn committed before the live stream ever connected', async () => {
    const recording = loadLiveFixture('plain.json')
    let release!: () => void
    const r = await rig(recording, {
      dbPathPending: path => new Promise<string>(resolve => { release = () => resolve(path) }),
    })
    r.server.setRefusing(true)
    await r.headless.start()
    r.pty.output()
    await replay(r, buildReplayScript(recording))
    release()
    await waitUntil(() => r.log.some(e => e.kind === 'error' && e.error.code === 'db_path_recovered_late'), 3000, 'late-open report')
  })

  // #10 recheck a and b: the TUI painted BEFORE the headless was constructed.
  // A subscription made by the headless would have missed it; the host's
  // spawn-time latch did not.
  it('reports a gap when the TUI painted before the headless existed', async () => {
    const recording = loadLiveFixture('plain.json')
    let release!: () => void
    const r = await rig(recording, {
      onSpawn: pty => pty.output(),
      dbPathPending: path => new Promise<string>(resolve => { release = () => resolve(path) }),
    })
    await startConnected(r)
    await replay(r, buildReplayScript(recording))
    release()
    await waitUntil(() => r.log.some(e => e.kind === 'error' && e.error.code === 'db_path_recovered_late'), 3000, 'late-open report')
  })

  // Without the host's spawn-time latch the ordering cannot be proven, so the
  // gap is reported rather than assumed away.
  it('reports a possible gap when the host passes no output latch', async () => {
    const recording = loadLiveFixture('plain.json')
    let release!: () => void
    const r = await rig(recording, {
      noOutputLatch: true,
      dbPathPending: path => new Promise<string>(resolve => { release = () => resolve(path) }),
    })
    await startConnected(r)
    release()
    await waitUntil(() => r.log.some(e => e.kind === 'error' && e.error.code === 'db_path_recovered_late'), 3000, 'late-open report')
  })

  it('reports and recovers through the ladder when the launch\'s pending lookup fails', async () => {
    const recording = loadLiveFixture('plain.json')
    const r = await rig(recording, {
      dbPathPending: () => Promise.reject(new Error('opencode db path timed out after 20000 ms')),
      dbPathRetryDelaysMs: [5],
      resolveDbPath: async () => r.dbPath,
    })
    await startConnected(r)
    await waitUntil(() => r.log.filter(e => e.kind === 'error').length >= 2, 3000, 'retry then recovery')
    const errors = r.log.filter((e): e is Extract<LogEntry, { kind: 'error' }> => e.kind === 'error')
    expect(errors[0]?.error.code).toBe('db_path_retrying')
    expect(errors[0]?.error.message).toContain('opencode db path timed out after 20000 ms')
  })

  // #10 review B (survivor): a lookup that "succeeds" with no path is a
  // failure, reported, and it releases delivery.
  it('treats an empty path from the launch\'s lookup as unavailable and releases delivery', async () => {
    const recording = loadLiveFixture('plain.json')
    const r = await rig(recording, { dbPathPending: async () => '' })
    await startConnected(r)
    await waitUntil(() => r.log.some(e => e.kind === 'error' && e.error.code === 'db_path_unavailable'), 3000, 'unavailable report')
    expect(await r.headless.submitPrompt('despite no path', { timeoutMs: 3000 })).toEqual({ ok: true })
  })

  it('opens no store when stopped while the launch\'s lookup is pending', async () => {
    const recording = loadLiveFixture('plain.json')
    let release!: () => void
    let opened = 0
    const r = await rig(recording, {
      dbPathPending: path => new Promise<string>(resolve => { release = () => resolve(path) }),
      openStore: path => { opened += 1; return openOpencodeStore(path) },
    })
    await startConnected(r)
    await r.headless.stop()
    release()
    await settle()
    expect(opened).toBe(0)
  })

  // #1397 review b and c (steering q97): after a late path recovery the store
  // can open while its first POSITIONING read is BUSY. The late report used to
  // fire right after `reader.start()`, before the reader had chosen its head.
  // The host's one history heal then ran too early, and a turn committed
  // before the positioning retry landed behind the new head, with no second
  // report: a silent loss. The report must come from the reader's
  // positioning, so a heal it triggers reads everything behind the head.
  it('reports a late recovery only once the reader has positioned, after a BUSY positioning read', async () => {
    const recording = loadLiveFixture('plain.json')
    let busy = true
    let okReads = 0
    const r = await rig(recording, {
      dbPath: null,
      dbPathRetryDelaysMs: [5],
      resolveDbPath: async () => r.dbPath,
      openStore: path => {
        const store = openOpencodeStore(path)
        const read = store.read.bind(store)
        return Object.assign(store, {
          read: <T,>(fn: Parameters<typeof read<T>>[0]): T => {
            if (busy) throw new OpencodeStoreError('busy', 'database is locked')
            okReads += 1
            return read(fn)
          },
        })
      },
    })
    // Record, at the moment of the report, whether any read had succeeded yet.
    const reportedAfterReads: number[] = []
    r.headless.on('transcript-error', error => {
      if (error.code === 'db_path_recovered_late') reportedAfterReads.push(okReads)
    })
    await startConnected(r)
    await waitUntil(() => r.log.some(e => e.kind === 'error' && e.error.code === 'db_path_retrying'), 3000, 'retrying report')
    // The path has recovered and the open is being retried against BUSY.
    await settle()
    // A turn is committed while the reader still cannot position.
    await replay(r, buildReplayScript(recording))
    expect(reportedAfterReads).toEqual([])
    busy = false
    await waitUntil(() => reportedAfterReads.length > 0, 3000, 'late-open report')
    expect(reportedAfterReads[0]).toBeGreaterThan(0)
    expect(reportedAfterReads).toHaveLength(1)
  })

  it('names the rows it lost when the database path arrives late', async () => {
    // #1114 review R1-F1/R2-F2. The headline recovery test below replays only
    // AFTER the retry lands, which is the one ordering in which completeness is
    // free. This one writes the session's rows while the channel is still dark
    // — the real shape of the incident, where the TUI ran for a full 20 s
    // timeout before anyone could read it — and pins what the pane ends up
    // with. The reader positions at the CURRENT head, so those rows are gone;
    // what must not happen is losing them silently.
    const recording = loadLiveFixture('plain.json')
    let release!: (path: string) => void
    const pending = new Promise<string>(resolve => { release = resolve })
    const r = await rig(recording, {
      dbPath: null,
      dbPathRetryDelaysMs: [5],
      resolveDbPath: () => pending,
    })
    await startConnected(r)
    // Everything the TUI commits here lands while the path is unavailable.
    await replay(r, buildReplayScript(recording))
    release(r.dbPath)
    await waitUntil(
      () => r.log.some(e => e.kind === 'error' && e.error.code === 'db_path_recovered_late'),
      3000,
      'late-open report',
    )

    const errors = r.log.filter((e): e is Extract<LogEntry, { kind: 'error' }> => e.kind === 'error')
    // Transient first, so a pane that heals is not banner-ed for life; then the
    // honest statement that this transcript has a hole in it.
    expect(errors.map(e => e.error.code)).toEqual(['db_path_retrying', 'db_path_recovered_late'])
    expect(errors[1]?.error.message).toContain('is missing from this pane\'s transcript')
    // The gap is real and this is the assertion that says so out loud: the
    // rows committed while dark are NOT emitted. If a later change heals them,
    // this expectation is what should be rewritten, deliberately.
    const ids = r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id)
    expect(ids).toEqual([])
    expect(expectedCommits(recording).ids.size).toBeGreaterThan(0)
  })

  it('still names the lost rows when the late open first meets a busy database', async () => {
    // agent-code#1229 review A: the same restore storm that times the path
    // lookup out is the one the store's BUSY retry exists for. The late open
    // then went through the busy retry, which opens the store without the
    // recovery report, so the hole was never named and the host never healed
    // it — while the pane read as healthy on its next row.
    const recording = loadLiveFixture('plain.json')
    let release!: (path: string) => void
    const pending = new Promise<string>(resolve => { release = resolve })
    let refusals = 1
    const r = await rig(recording, {
      dbPath: null,
      dbPathRetryDelaysMs: [5],
      resolveDbPath: () => pending,
      openStore: path => {
        if (refusals > 0) {
          refusals -= 1
          throw new OpencodeStoreError('busy', 'OpenCode schema check: database busy')
        }
        return openOpencodeStore(path)
      },
    })
    await startConnected(r)
    await replay(r, buildReplayScript(recording))
    release(r.dbPath)
    await waitUntil(
      () => r.log.some(e => e.kind === 'error' && e.error.code === 'db_path_recovered_late'),
      3000,
      'late-open report after a busy open',
    )
    const codes = r.log.filter((e): e is Extract<LogEntry, { kind: 'error' }> => e.kind === 'error').map(e => e.error.code)
    // Once, and only after the channel really opened.
    expect(codes).toEqual(['db_path_retrying', 'db_path_recovered_late'])
  })

  it('recovers the committed stream when a retried database path resolves', async () => {
    const recording = loadLiveFixture('plain.json')
    let attempts = 0
    // The rig's own dbPath is a real database with the session already seeded,
    // so a successful retry has to produce a genuinely readable channel — not
    // merely a non-null string that silences the error.
    let real = ''
    const r = await rig(recording, {
      dbPath: null,
      dbPathRetryDelaysMs: [5, 5, 5],
      resolveDbPath: async () => {
        attempts += 1
        // Fails exactly the way the incident did, then succeeds the way the
        // very next attempt would have.
        if (attempts === 1) throw new Error('`opencode db path` timed out after 20000 ms and was killed with SIGTERM')
        return real
      },
    })
    real = r.dbPath
    await startConnected(r)
    await waitUntil(() => attempts >= 2, 3000, 'db path retried')
    await replay(r, buildReplayScript(recording))

    // The degraded state was reported once, up front — a dark pane must say so
    // rather than look healthy while it retries — and under the RETRYING code,
    // never the permanent one. `db_path_unavailable` means "cannot run,
    // permanently" to the renderer's lifetime banner and to
    // `managedTranscriptUnavailableReason` (#864 AC8), with no retraction
    // anywhere; emitting it for a pane that then healed left it marked broken
    // over a working transcript for the life of the app (review R1-F5/R2-F1).
    const codes = r.log.filter((e): e is Extract<LogEntry, { kind: 'error' }> => e.kind === 'error').map(e => e.error.code)
    expect(codes).not.toContain('db_path_unavailable')
    expect(codes[0]).toBe('db_path_retrying')
    // And then the channel actually works: every row the recording commits.
    await waitUntil(
      () => r.log.some(e => e.kind === 'semantic' && e.event.type === 'turn_completed'),
      5000,
      'turn end after recovery',
    )
    const ids = r.log.filter((e): e is Extract<LogEntry, { kind: 'entry' }> => e.kind === 'entry').map(e => e.record.info.id)
    expect(new Set(ids)).toEqual(expectedCommits(recording).ids)
  })

  it('stops retrying the database path, and says it has, once the ladder is spent', async () => {
    let attempts = 0
    const r = await rig(loadLiveFixture('plain.json'), {
      dbPath: null,
      dbPathRetryDelaysMs: [5, 5],
      resolveDbPath: async () => {
        attempts += 1
        throw new Error('`opencode db path` could not be started (ENOENT)')
      },
    })
    await r.headless.start()
    await waitUntil(() => r.log.filter(e => e.kind === 'error').length === 2, 3000, 'recovery abandoned')

    // Exactly the ladder, and not one attempt more: a broken install must not
    // respawn a ~143 MB process forever behind the user's back.
    expect(attempts).toBe(2)
    const errors = r.log.filter((e): e is Extract<LogEntry, { kind: 'error' }> => e.kind === 'error')
    expect(errors[0]?.error.message).toContain('Retrying in the background')
    expect(errors[1]?.error.message).toContain('still unavailable after 2 retries')
    expect(errors[1]?.error.message).toContain('ENOENT')
    // Negative window: the spent ladder must not arm another timer.
    await settle(60)
    expect(attempts).toBe(2)
  })

  it('never opens a store from a database path that resolved after stop()', async () => {
    // The awaited resolve cannot be cancelled, so its continuation is the fence.
    // Without it a stopped pane opens a SQLite handle nobody will ever release.
    let release!: (path: string) => void
    const pending = new Promise<string>(resolve => { release = resolve })
    let opened = 0
    const r = await rig(loadLiveFixture('plain.json'), {
      dbPath: null,
      dbPathRetryDelaysMs: [5],
      resolveDbPath: () => pending,
      openStore: path => {
        opened += 1
        return openOpencodeStore(path)
      },
    })
    await r.headless.start()
    await settle(40)
    await r.headless.stop()
    release(r.dbPath)
    await settle(60)

    expect(opened).toBe(0)
  })
})
