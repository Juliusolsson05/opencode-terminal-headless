// Stage 0 live probe: record what the native OpenCode TUI actually emits when
// it is launched the way this package will launch it.
//
// Usage:
//   NODE_PTY_PATH=/abs/path/to/node_modules/node-pty \
//   npm run probe:live -- --out testing/fixtures/live [--scenario plain,permission-once,...]
//                         [--binary ~/.opencode/bin/opencode] [--model opencode/big-pickle]
//
// WHY a probe instead of trusting the source: the live reader keys on bus
// event names and payload paths. The sibling research that documents them was
// written against OpenCode 1.14; this package targets 1.18.x. Recording the
// real stream — together with the durable rows and their visibility timing —
// turns the decomposition's live unknowns into fixtures the tests replay.
//
// SAFETY: every run uses a throwaway HOME/XDG tree under `.probe/`, a free
// `opencode/*` model, `OPENCODE_DISABLE_AUTOUPDATE=1` (the binary lives in the
// user's real ~/.opencode and must never be upgraded by a probe) and sharing
// disabled. `OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS` is never inherited — the
// probe needs real permission prompts. No user data is read or written.

import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { fixtureMeta } from './lib/fixtureMeta.mjs'

import { loadSqlite, type SqliteDatabase } from '../src/transcript/sqlite.js'

const execFileAsync = promisify(execFile)

type PtyLike = {
  pid: number
  write(data: string): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void }
}
type PtyModule = { spawn(file: string, args: string[], opts: Record<string, unknown>): PtyLike }

type Args = { out: string; scenarios: string[]; binary: string; model: string }

const ALL_SCENARIOS = ['plain', 'permission-once', 'permission-reject', 'question-reject', 'queued', 'port-conflict']

function parseArgs(argv: string[]): Args {
  const home = process.env.HOME ?? ''
  const out: Args = {
    out: 'testing/fixtures/live',
    scenarios: ALL_SCENARIOS,
    binary: join(home, '.opencode/bin/opencode'),
    model: 'opencode/big-pickle',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!value) continue
    if (flag === '--out') { out.out = value; i += 1 }
    else if (flag === '--scenario') { out.scenarios = value.split(','); i += 1 }
    else if (flag === '--binary') { out.binary = value; i += 1 }
    else if (flag === '--model') { out.model = value; i += 1 }
  }
  return out
}

const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

async function allocatePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

type Recording = {
  meta: ReturnType<typeof fixtureMeta>
  scenario: string
  opencodeVersion: string
  model: string
  sessionID: string
  notes: string[]
  sse: Array<{ t: number; event: unknown }>
  durable: Array<{ t: number; rowid: number; aggregateID: string; seq: number; type: string; data: unknown }>
  http: Array<{ t: number; method: string; path: string; auth: boolean; status: number; body: unknown }>
  prompts: Array<{ t: number; text: string }>
  pty: { firstOutputAt: number | null; bytes: number; exit: { exitCode: number; signal?: number; t: number } | null; tail: string }
}

class Sandbox {
  readonly root: string
  readonly home: string
  readonly project: string
  constructor(base: string) {
    this.root = resolve(base, `${Date.now()}-${randomBytes(3).toString('hex')}`)
    this.home = join(this.root, 'home')
    this.project = join(this.root, 'project')
  }

  env(binary: string, model: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: `${dirname(binary)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: this.home,
      XDG_DATA_HOME: join(this.home, '.local/share'),
      XDG_CONFIG_HOME: join(this.home, '.config'),
      XDG_STATE_HOME: join(this.home, '.local/state'),
      XDG_CACHE_HOME: join(this.home, '.cache'),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model,
        autoupdate: false,
        share: 'disabled',
        permission: { bash: 'ask' },
      }),
      ...extra,
    }
  }

  async create(): Promise<void> {
    await mkdir(this.home, { recursive: true })
    await mkdir(this.project, { recursive: true })
    await writeFile(join(this.project, 'README.md'), '# probe project\n\nA throwaway directory for the OpenCode live probe.\n')
    await execFileAsync('git', ['init', '-q'], { cwd: this.project })
  }
}

async function runCli(binary: string, args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync(binary, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

async function importEmptySession(binary: string, sandbox: Sandbox, env: Record<string, string>): Promise<string> {
  // Mirrors Agent Code's createEmptyOpencodeSession: the TUI is launched with
  // a known id so the durable tail knows its aggregate before the first write.
  const sessionID = `ses_${randomUUID().replaceAll('-', '')}`
  const now = Date.now()
  const file = join(sandbox.root, `${sessionID}.json`)
  await writeFile(file, JSON.stringify({
    info: {
      id: sessionID, slug: 'probe', projectID: 'probe', directory: sandbox.project, path: '',
      title: 'probe', version: '0.0.0-probe', time: { created: now, updated: now },
    },
    messages: [],
  }))
  await runCli(binary, ['import', file], sandbox.project, env)
  return sessionID
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[()][A-Za-z0-9]/g, '')
}

class ScenarioRun {
  readonly t0 = performance.now()
  readonly rec: Recording
  private readonly abort = new AbortController()
  private tailTimer: ReturnType<typeof setInterval> | null = null
  private db: SqliteDatabase | null = null
  private lastRowid = 0
  pty: PtyLike | null = null
  url = ''
  password = randomBytes(24).toString('base64url')
  private outputTail = ''

  constructor(readonly scenario: string, readonly args: Args, readonly sandbox: Sandbox, readonly env: Record<string, string>, version: string, sessionID: string) {
    this.rec = {
      meta: fixtureMeta(version), scenario, opencodeVersion: version, model: args.model, sessionID, notes: [], sse: [], durable: [], http: [], prompts: [],
      pty: { firstOutputAt: null, bytes: 0, exit: null, tail: '' },
    }
  }

  now(): number {
    return Math.round((performance.now() - this.t0) * 10) / 10
  }

  note(text: string): void {
    this.rec.notes.push(`[${this.now()}ms] ${text}`)
    console.error(`  ${this.scenario}: ${text}`)
  }

  headers(auth = true): Record<string, string> {
    const headers: Record<string, string> = { 'x-opencode-directory': this.sandbox.project }
    if (auth) headers.Authorization = `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`
    return headers
  }

  async http(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; body: unknown }> {
    const response = await fetch(new URL(path, this.url), {
      method,
      headers: { ...this.headers(auth), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    let parsed: unknown = text
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text.slice(0, 500) }
    this.rec.http.push({ t: this.now(), method, path, auth, status: response.status, body: parsed })
    return { status: response.status, body: parsed }
  }

  spawnTui(ptyModule: PtyModule, port: number, extraArgs: string[] = []): void {
    this.url = `http://127.0.0.1:${port}`
    const args = ['--session', this.rec.sessionID, '--hostname', '127.0.0.1', '--port', String(port), ...extraArgs]
    this.note(`spawn opencode ${args.join(' ')}`)
    const pty = ptyModule.spawn(this.args.binary, args, {
      name: 'xterm-256color', cols: 120, rows: 40, cwd: this.sandbox.project,
      env: { ...this.env, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: this.password },
    })
    this.pty = pty
    pty.onData(data => {
      if (this.rec.pty.firstOutputAt === null) this.rec.pty.firstOutputAt = this.now()
      this.rec.pty.bytes += data.length
      this.outputTail = (this.outputTail + data).slice(-20_000)
    })
    pty.onExit(event => {
      this.rec.pty.exit = { ...event, t: this.now() }
      this.note(`tui exited code=${event.exitCode} signal=${event.signal ?? ''}`)
    })
  }

  async waitForServer(timeoutMs = 90_000): Promise<boolean> {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      if (this.rec.pty.exit) return false
      try {
        // WHY a per-request timeout: undici waits 300 s for response headers
        // by default. A server that accepts the connection but is still
        // bootstrapping its project instance would otherwise stall the probe
        // for five minutes on a single poll (observed on the first run).
        const response = await fetch(new URL('/session/status', this.url), { headers: this.headers(), signal: AbortSignal.timeout(5000) })
        if (response.ok) {
          await response.text()
          this.note(`server healthy (${response.status})`)
          return true
        }
      } catch {
        // Not listening yet; keep polling until the deadline.
      }
      await sleep(100)
    }
    return false
  }

  startSse(): void {
    void (async () => {
      try {
        const response = await fetch(new URL('/event', this.url), { headers: { ...this.headers(), accept: 'text/event-stream' }, signal: this.abort.signal })
        this.note(`sse connected (${response.status})`)
        if (!response.body) return
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
            if (data) {
              let event: unknown = data
              try { event = JSON.parse(data) } catch { /* keep raw */ }
              this.rec.sse.push({ t: this.now(), event })
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch (error) {
        if (!this.abort.signal.aborted) this.note(`sse error: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  async startDurableTail(): Promise<void> {
    const dbPath = await runCli(this.args.binary, ['db', 'path'], this.sandbox.project, this.env)
    const { DatabaseSync } = loadSqlite()
    this.db = new DatabaseSync(dbPath, { readOnly: true })
    const statement = this.db.prepare('SELECT rowid, aggregate_id, seq, type, data FROM event WHERE rowid > ? ORDER BY rowid')
    this.tailTimer = setInterval(() => {
      try {
        for (const row of statement.all(this.lastRowid)) {
          this.lastRowid = Number(row.rowid)
          this.rec.durable.push({
            t: this.now(), rowid: this.lastRowid, aggregateID: String(row.aggregate_id), seq: Number(row.seq), type: String(row.type),
            data: JSON.parse(String(row.data)),
          })
        }
      } catch (error) {
        this.note(`durable tail error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, 20)
  }

  statusEvents(): Array<{ t: number; type: string }> {
    const out: Array<{ t: number; type: string }> = []
    for (const { t, event } of this.rec.sse) {
      const e = event as { type?: string; properties?: { sessionID?: string; status?: { type?: string } } }
      if (e?.properties?.sessionID !== this.rec.sessionID) continue
      if (e.type === 'session.status') out.push({ t, type: e.properties.status?.type ?? 'unknown' })
      if (e.type === 'session.idle') out.push({ t, type: 'idle-event' })
    }
    return out
  }

  async waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      if (predicate()) return true
      if (this.rec.pty.exit) break
      await sleep(50)
    }
    this.note(`timeout waiting for ${label}`)
    return false
  }

  async waitForTuiReady(): Promise<void> {
    await this.waitFor(() => this.rec.pty.firstOutputAt !== null, 30_000, 'first pty output')
    // The TUI mounts its composer shortly after the first paint; a fixed
    // grace mirrors what Agent Code's readiness does today.
    await sleep(3000)
  }

  paste(text: string): void {
    this.rec.prompts.push({ t: this.now(), text })
    this.pty?.write(`\x1b[200~${text}\x1b[201~\r`)
    this.note(`pasted prompt (${text.length} chars)`)
  }

  async waitForTurn(busyCountBefore: number, timeoutMs = 150_000): Promise<boolean> {
    const busyIndex = () => this.statusEvents().filter(s => s.type === 'busy').length
    const sawBusy = await this.waitFor(() => busyIndex() > busyCountBefore, 60_000, 'busy')
    if (!sawBusy) return false
    return await this.waitFor(() => {
      const statuses = this.statusEvents()
      const lastBusy = statuses.map(s => s.type).lastIndexOf('busy')
      return statuses.slice(lastBusy + 1).some(s => s.type === 'idle' || s.type === 'idle-event')
    }, timeoutMs, 'idle after busy')
  }

  firstEvent(types: string[]): { t: number; event: Record<string, unknown> } | undefined {
    return this.rec.sse.find(({ event }) => types.includes(String((event as { type?: string })?.type))) as
      { t: number; event: Record<string, unknown> } | undefined
  }

  async stop(): Promise<void> {
    this.abort.abort()
    if (this.tailTimer) clearInterval(this.tailTimer)
    // One last drain so rows written during shutdown are part of the record.
    await sleep(200)
    this.db?.close()
    if (this.pty && !this.rec.pty.exit) {
      this.pty.kill('SIGTERM')
      await this.waitFor(() => this.rec.pty.exit !== null, 5000, 'tui exit after SIGTERM')
      if (!this.rec.pty.exit) this.pty.kill('SIGKILL')
    }
    this.rec.pty.tail = stripAnsi(this.outputTail).replace(/\s+/g, ' ').slice(-1500)
  }
}

function requestIDOf(event: Record<string, unknown>): string | undefined {
  const props = (event.properties ?? {}) as Record<string, unknown>
  for (const key of ['id', 'requestID', 'permissionID']) if (typeof props[key] === 'string') return props[key] as string
  return undefined
}

async function scenarioBody(run: ScenarioRun, ptyModule: PtyModule): Promise<void> {
  const port = await allocatePort()

  if (run.scenario === 'port-conflict') {
    // Hold the port with an HTTP server that answers 418, then ask the TUI to
    // bind it. A 418 proves our blocker still owns the port; a 200/401 would
    // mean OpenCode bound it anyway (e.g. with SO_REUSEPORT).
    //
    // WHY an HTTP blocker and explicit timeouts: the first version held the
    // port with a raw TCP server, which accepts connections and never answers.
    // fetch then waited out undici's 300 s header timeout and server.close()
    // waited for the lingering socket, so the probe never finished.
    const blocker = createHttpServer((_request, response) => {
      response.writeHead(418, { 'content-type': 'text/plain' })
      response.end('probe blocker')
    })
    await new Promise<void>(resolveListen => blocker.listen(port, '127.0.0.1', () => resolveListen()))
    run.spawnTui(ptyModule, port)
    await run.waitFor(() => run.rec.pty.exit !== null, 25_000, 'exit on port conflict')
    try {
      const response = await fetch(new URL('/session/status', run.url), { headers: run.headers(), signal: AbortSignal.timeout(3000) })
      run.note(`request to the contested port answered ${response.status} (${(await response.text()).slice(0, 40)})`)
    } catch (error) {
      run.note(`request to the contested port failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    run.note(`tui still running after conflict: ${run.rec.pty.exit === null}`)
    blocker.closeAllConnections()
    await new Promise<void>(resolveClose => blocker.close(() => resolveClose()))
    return
  }

  run.spawnTui(ptyModule, port)
  if (!(await run.waitForServer())) throw new Error('server never became healthy')
  run.startSse()
  await run.startDurableTail()

  // Auth enforcement and the re-sync endpoints the live reader relies on.
  await run.http('GET', '/session/status', undefined, false)
  await run.http('GET', '/session/status')
  await run.http('GET', '/permission')
  await run.http('GET', '/question')

  await run.waitForTuiReady()

  if (run.scenario === 'plain') {
    run.paste('Reply with exactly one word: pong')
    await run.waitForTurn(0)
  } else if (run.scenario === 'permission-once' || run.scenario === 'permission-reject') {
    run.paste('Use the bash tool to run the command `ls -1` in the current directory, then tell me how many entries it printed.')
    const asked = await run.waitFor(() => run.firstEvent(['permission.asked', 'permission.updated']) !== undefined, 90_000, 'permission.asked')
    if (asked) {
      const event = run.firstEvent(['permission.asked', 'permission.updated'])!.event
      await run.http('GET', '/permission')
      await run.http('GET', '/session/status')
      const id = requestIDOf(event)
      run.note(`permission request id=${id ?? '<none>'}`)
      if (id) await run.http('POST', `/permission/${encodeURIComponent(id)}/reply`, { reply: run.scenario === 'permission-once' ? 'once' : 'reject' })
    }
    await run.waitFor(() => {
      const statuses = run.statusEvents()
      return statuses.length > 0 && ['idle', 'idle-event'].includes(statuses[statuses.length - 1]!.type)
    }, 150_000, 'idle after permission')
  } else if (run.scenario === 'question-reject') {
    run.paste('Use the question tool to ask me whether I prefer red or blue. Do not answer it yourself and do not guess.')
    const asked = await run.waitFor(() => run.firstEvent(['question.asked', 'question.updated']) !== undefined, 90_000, 'question.asked')
    if (asked) {
      const event = run.firstEvent(['question.asked', 'question.updated'])!.event
      await run.http('GET', '/question')
      const id = requestIDOf(event)
      run.note(`question request id=${id ?? '<none>'}`)
      if (id) await run.http('POST', `/question/${encodeURIComponent(id)}/reject`, {})
    }
    await run.waitFor(() => {
      const statuses = run.statusEvents()
      return statuses.length > 0 && ['idle', 'idle-event'].includes(statuses[statuses.length - 1]!.type)
    }, 150_000, 'idle after question')
  } else if (run.scenario === 'queued') {
    run.paste('Write the numbers from 1 to 60, one per line, and nothing else.')
    await run.waitFor(() => run.statusEvents().some(s => s.type === 'busy'), 60_000, 'first busy')
    await sleep(1500)
    run.paste('Now reply with exactly one word: second')
    // Wait for two assistant completions, or a long quiet idle.
    await run.waitFor(() => {
      const statuses = run.statusEvents()
      const idles = statuses.filter(s => s.type === 'idle' || s.type === 'idle-event').length
      return idles >= 2 || (idles >= 1 && run.now() - statuses[statuses.length - 1]!.t > 15_000)
    }, 240_000, 'queued prompts to finish')
  }
  // Give trailing durable writes a moment to be captured.
  await sleep(1500)
}

// Replace every sandbox path with /sandbox so recordings are stable and do
// not carry the recording machine's temp directory layout.
//
// WHY the temp directory is also rewritten: the TUI's footer prints the cwd,
// and the renderer wraps it across lines, so the full sandbox root never
// appears as one string in the captured terminal tail. Rewriting the OS temp
// prefix (and its /private realpath on macOS) catches every wrapped fragment.
function normalise(value: unknown, sandbox: Sandbox, port: string): unknown {
  const temp = tmpdir()
  const text = JSON.stringify(value)
    .split(sandbox.root).join('/sandbox')
    .split(`/private${temp}`).join('/tmp')
    .split(temp).join('/tmp')
    .split(`127.0.0.1:${port}`).join('127.0.0.1:0')
  return JSON.parse(text)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  // WHY require and an explicit path: node-pty is an optional peer, and the
  // copy Agent Code ships is compiled for Electron's ABI. The probe runs under
  // plain Node, so it loads a Node-ABI build from NODE_PTY_PATH. CommonJS
  // require resolves a package directory; an ESM import of a directory does not.
  const ptyPath = process.env.NODE_PTY_PATH ?? 'node-pty'
  const ptyModule = createRequire(import.meta.url)(ptyPath) as PtyModule
  if (!existsSync(args.binary)) throw new Error(`opencode binary not found at ${args.binary}`)
  await mkdir(args.out, { recursive: true })

  for (const scenario of args.scenarios) {
    // WHY the OS temp directory and not `.probe/` inside the package: OpenCode
    // treats the enclosing git worktree as the project and snapshots it when
    // the instance boots. Inside Agent Code's checkout that snapshot covers the
    // whole repository and every request blocks behind it (first run: the
    // server accepted connections but answered nothing for 300 s).
    const sandbox = new Sandbox(join(tmpdir(), 'opencode-terminal-headless-probe'))
    await sandbox.create()
    const env = sandbox.env(args.binary, args.model)
    const version = await runCli(args.binary, ['--version'], sandbox.project, env)
    const sessionID = await importEmptySession(args.binary, sandbox, env)
    const run = new ScenarioRun(scenario, args, sandbox, env, version, sessionID)
    console.error(`scenario ${scenario}: session ${sessionID} (opencode ${version})`)
    try {
      await scenarioBody(run, ptyModule)
    } catch (error) {
      run.note(`scenario failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await run.stop()
    }
    const port = new URL(run.url || 'http://127.0.0.1:0').port
    const file = join(args.out, `${scenario}.json`)
    await writeFile(file, `${JSON.stringify(normalise(run.rec, sandbox, port), null, 2)}\n`)
    console.error(`  wrote ${file}: sse=${run.rec.sse.length} durable=${run.rec.durable.length} http=${run.rec.http.length}`)
    await rm(sandbox.root, { recursive: true, force: true })
  }
}

await main()
