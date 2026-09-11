// Recorded-replay harness: re-enact a Stage 0 live recording against the whole
// package (or a host that embeds it) over real sockets and a real SQLite file.
//
// WHY this exists: unit tests prove each layer against recordings, but the
// failure modes that matter to Agent Code — an answer arriving after idle, a
// turn that never ends, a badge that never clears — live in the seams between
// layers. The harness drives every seam at once with what OpenCode actually
// did, instead of with what a test author believes it does.
//
// Faithfulness rules:
// - Durable rows are written by LiveFixtureWriter (projection + event log in
//   one immediate transaction per row, like OpenCode's projectors).
// - Each durable row is written IMMEDIATELY BEFORE its bus twin is sent. The
//   recording's own timestamps cannot be trusted for this order (its durable
//   tail polled every 20 ms), but OpenCode's source commits before it publishes
//   and the recording confirms it wherever the timing is resolvable.
// - The server enforces Basic auth and answers the re-sync endpoints from the
//   state implied by the events it has sent so far — the same truth the real
//   server would report.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { PtyDisposable, PtyLike } from '../terminal/PtyBinding.js'
import type { LiveFixtureWriter } from './fixtureDatabase.js'
import type { LiveFixture } from './fixtures.js'

type BusEvent = LiveFixture['sse'][number]['event']
type DurableRow = LiveFixture['durable'][number]

export type ReplayStep =
  | { kind: 'durable'; row: DurableRow }
  | { kind: 'sse'; event: BusEvent; index: number }

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

/** Merge a recording into one ordered script, durable twins first. */
export function buildReplayScript(recording: LiveFixture): ReplayStep[] {
  const own = recording.durable.filter(row => row.aggregateID === recording.sessionID)
  const twinOf = new Map<number, number>() // sse index → durable index
  const used = new Set<number>()
  recording.sse.forEach(({ event }, sseIndex) => {
    for (let d = 0; d < own.length; d += 1) {
      if (used.has(d)) continue
      const row = own[d]!
      if (row.type.slice(0, row.type.lastIndexOf('.')) !== event.type) continue
      if (stable(row.data) !== stable(event.properties)) continue
      twinOf.set(sseIndex, d)
      used.add(d)
      break
    }
  })
  const script: ReplayStep[] = []
  const written = new Set<number>()
  const writeUpTo = (limitT: number) => {
    // Untwinned rows (e.g. session.updated, whose bus form carries the full
    // session) go in by recorded time, still before anything that follows.
    own.forEach((row, d) => {
      if (!written.has(d) && !used.has(d) && row.t <= limitT) {
        script.push({ kind: 'durable', row })
        written.add(d)
      }
    })
  }
  recording.sse.forEach(({ t, event }, index) => {
    writeUpTo(t)
    const twin = twinOf.get(index)
    if (twin !== undefined) {
      // Also flush every earlier durable row: seq order must be preserved.
      own.forEach((row, d) => {
        if (d <= twin && !written.has(d)) {
          script.push({ kind: 'durable', row })
          written.add(d)
        }
      })
    }
    script.push({ kind: 'sse', event, index })
  })
  own.forEach((row, d) => {
    if (!written.has(d)) script.push({ kind: 'durable', row })
  })
  return script
}

type Stream = { res: ServerResponse }

/** A stand-in for the TUI's HTTP server, driven by a replay script. */
export class ReplayServer {
  readonly calls: Array<{ method: string; path: string; body: string; authorized: boolean }> = []
  private server: Server | null = null
  private readonly streams = new Set<Stream>()
  private refusing = false
  private readonly status = new Map<string, string>()
  private readonly permissions = new Map<string, Record<string, unknown>>()
  private readonly questions = new Map<string, Record<string, unknown>>()
  private readonly failing = new Set<string>()
  private readonly holds = new Map<string, (deliver: () => void) => void>()
  url = ''

  constructor(private readonly credentials: { username: string; password: string }) {}

  async listen(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', () => resolve()))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  /** Send one bus event to every open stream and update the implied state. */
  send(event: BusEvent): void {
    const props = (event.properties ?? {}) as Record<string, unknown>
    if (event.type === 'session.status') {
      const type = (props.status as { type?: string } | undefined)?.type ?? 'idle'
      if (type === 'idle') this.status.delete(String(props.sessionID))
      else this.status.set(String(props.sessionID), type)
    } else if (event.type === 'session.idle') this.status.delete(String(props.sessionID))
    else if (event.type === 'permission.asked' || event.type === 'permission.updated') this.permissions.set(String(props.id), props)
    else if (event.type === 'permission.replied') this.permissions.delete(String(props.requestID))
    else if (event.type === 'question.asked' || event.type === 'question.updated') this.questions.set(String(props.id), props)
    else if (event.type === 'question.replied' || event.type === 'question.rejected') this.questions.delete(String(props.requestID))
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const stream of this.streams) stream.res.write(frame)
  }

  /** Close every open event stream (simulates a dropped connection). */
  dropStreams(): void {
    for (const stream of this.streams) stream.res.end()
    this.streams.clear()
  }

  /** While refusing, /event answers 503 so clients stay disconnected. */
  setRefusing(refusing: boolean): void {
    this.refusing = refusing
  }

  openStreamCount(): number {
    return this.streams.size
  }

  /** While set, requests to `path` answer 500 (one endpoint of a re-sync failing). */
  setFailing(path: string, failing: boolean): void {
    if (failing) this.failing.add(path)
    else this.failing.delete(path)
  }

  /**
   * Hold the next request to `path`. Its answer is computed when the request
   * arrives (the server's state at that moment) but sent only when `release`
   * is called: a snapshot that arrives late and stale.
   */
  holdNext(path: string): { arrived: Promise<void>; release: () => void } {
    let deliver: (() => void) | null = null
    let released = false
    let signalArrived!: () => void
    const arrived = new Promise<void>(resolve => { signalArrived = resolve })
    this.holds.set(path, send => {
      deliver = send
      signalArrived()
      if (released) send()
    })
    return {
      arrived,
      release: () => {
        released = true
        deliver?.()
      },
    }
  }

  async close(): Promise<void> {
    this.dropStreams()
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server!.close(() => resolve()))
    this.server = null
  }

  private authorized(req: IncomingMessage): boolean {
    const expected = `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}`
    return req.headers.authorization === expected
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const authorized = this.authorized(req)
      const path = (req.url ?? '/').split('?')[0]!
      this.calls.push({ method: req.method ?? 'GET', path, body, authorized })
      if (!authorized) {
        res.writeHead(401).end()
        return
      }
      if (this.failing.has(path)) {
        res.writeHead(500).end()
        return
      }
      const hold = this.holds.get(path)
      if (hold) this.holds.delete(path)
      const json = (value: unknown) => {
        const body = JSON.stringify(value)
        const send = () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(body)
        }
        if (hold) hold(send)
        else send()
      }
      if (req.method === 'GET' && path === '/event') {
        if (this.refusing) {
          res.writeHead(503).end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
        const stream = { res }
        this.streams.add(stream)
        // WHY `res` and not `req`: an IncomingMessage emits 'close' as soon as
        // its (empty) request body has been consumed, which for a GET is
        // immediately — deregistering the stream before a single event could
        // be sent. The response closes only when the connection does.
        res.on('close', () => this.streams.delete(stream))
        return
      }
      if (req.method === 'GET' && path === '/session/status') return json(Object.fromEntries([...this.status].map(([id, type]) => [id, { type }])))
      if (req.method === 'GET' && path === '/permission') return json([...this.permissions.values()])
      if (req.method === 'GET' && path === '/question') return json([...this.questions.values()])
      if (req.method === 'POST' && /^\/permission\/[^/]+\/reply$/.test(path)) return json(true)
      if (req.method === 'POST' && /^\/question\/[^/]+\/reject$/.test(path)) return json(true)
      res.writeHead(404).end()
    })
  }
}

/** Minimal caller-owned PTY for tests: records writes, lets the test end it. */
export class FakePty implements PtyLike {
  readonly pid = 4242
  readonly writes: string[] = []
  readonly sizes: Array<[number, number]> = []
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows])
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): PtyDisposable {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  exit(exitCode = 0, signal?: number): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode, signal })
  }

  listenerCount(): number {
    return this.exitListeners.size
  }
}

/** Yield to the event loop long enough for sockets and microtasks to settle. */
export async function settle(ms = 5): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await settle(5)
  }
}

export type ReplayOptions = {
  /** Called before each step; return false to pause (the test resumes by calling again). */
  beforeStep?: (step: ReplayStep, index: number) => Promise<void> | void
  /** Delay between SSE steps so the client processes them one by one. */
  stepDelayMs?: number
}

/** Play a script: durable rows through the writer, bus events through the server. */
export async function playReplay(script: readonly ReplayStep[], writer: LiveFixtureWriter, server: ReplayServer, options: ReplayOptions = {}): Promise<void> {
  for (let index = 0; index < script.length; index += 1) {
    const step = script[index]!
    await options.beforeStep?.(step, index)
    if (step.kind === 'durable') writer.apply(step.row.type, step.row.data)
    else {
      server.send(step.event)
      await settle(options.stepDelayMs ?? 2)
    }
  }
  await settle(20)
}

/** A session row satisfying OpenCode's NOT NULL columns, for recordings (which carry none). */
export function sessionRowFor(sessionID: string): Record<string, unknown> {
  const now = Date.now()
  return { id: sessionID, project_id: 'replay', slug: 'replay', directory: '/sandbox/project', title: 'replay', version: '1.18.30', time_created: now, time_updated: now }
}
