import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'

import { afterEach, describe, expect, it } from 'vitest'

import { LiveServerClient } from './LiveServerClient.js'
import { SseStream } from './SseStream.js'
import type { LiveBusEvent } from './types.js'

// A real local HTTP server stands in for the TUI's server so the transport is
// tested over sockets, framing and reconnects as they actually happen.

let server: Server | null = null
let stream: SseStream | null = null

afterEach(async () => {
  stream?.stop()
  stream = null
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = null
  }
})

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  server = createServer(handler)
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

// Monotonic deadline: a wall-clock correction must not shrink or stretch it.
const waitFor = async (predicate: () => boolean, ms = 3000) => {
  const deadline = performance.now() + ms
  while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

/**
 * The upstream instance middleware's directory rule (sst/opencode@v1.18.30
 * packages/opencode/src/server/routes/instance/middleware.ts): the header is
 * `decodeURIComponent`ed, and left as is if that throws.
 */
function upstreamDirectoryOf(req: IncomingMessage): string {
  const raw = String(req.headers['x-opencode-directory'] ?? '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

describe('SseStream', () => {
  it('sends auth and directory headers and parses multi-line, CRLF and comment frames', async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = []
    const base = await listen((req, res) => {
      seen.push(req.headers)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': keep-alive\n\n')
      res.write('data: {"type":"server.connected","properties":{}}\n\n')
      res.write('data: {"type":"session.status",\ndata: "properties":{"sessionID":"ses_a","status":{"type":"busy"}}}\r\n\r\n')
      res.write('data: not json\n\n')
    })
    const client = new LiveServerClient({ baseUrl: base, username: 'opencode', password: 'secret', directory: '/work/project' })
    const events: LiveBusEvent[] = []
    stream = new SseStream({ url: client.eventUrl(), headers: client.headers() })
    stream.on('event', event => events.push(event))
    stream.start()
    await waitFor(() => events.length === 2)
    expect(events.map(event => event.type)).toEqual(['server.connected', 'session.status'])
    expect(seen[0]!.authorization).toBe(`Basic ${Buffer.from('opencode:secret').toString('base64')}`)
    expect(decodeURIComponent(String(seen[0]!['x-opencode-directory']))).toBe('/work/project')
  })

  it('reaches the instance for ASCII, non-Latin and literal-percent project directories over SSE and HTTP', async () => {
    // A fake server applying the upstream decoding rule; the oracle is the
    // directory the TUI was launched in, which the server must see verbatim.
    const directories = ['/work/project', '/tmp/项目', '/tmp/work%20tree']
    const seenDirectories: string[] = []
    const base = await listen((req, res) => {
      seenDirectories.push(upstreamDirectoryOf(req))
      if (req.url === '/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"type":"server.connected","properties":{}}\n\n')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(req.url === '/session/status' ? '{}' : '[]')
    })
    for (const directory of directories) {
      seenDirectories.length = 0
      const client = new LiveServerClient({ baseUrl: base, username: 'opencode', password: 'pw', directory })
      // Header construction itself must not throw (fetch headers are ByteStrings).
      expect(() => new Headers(client.headers())).not.toThrow()
      const events: LiveBusEvent[] = []
      stream = new SseStream({ url: client.eventUrl(), headers: client.headers() })
      stream.on('event', event => events.push(event))
      stream.start()
      await waitFor(() => events.length === 1)
      const { failures } = await client.readResyncSnapshot()
      expect(failures).toEqual([])
      expect(seenDirectories).toEqual([directory, directory, directory, directory])
      stream.stop()
    }
  })

  it('reconnects after the server drops the stream, and reports the gap', async () => {
    let connections = 0
    const base = await listen((_req, res) => {
      connections += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: {"type":"server.connected","properties":{"n":${connections}}}\n\n`)
      if (connections === 1) setTimeout(() => res.end(), 20)
    })
    const opens: number[] = []
    const disconnects: string[] = []
    stream = new SseStream({ url: `${base}/event`, headers: {}, initialBackoffMs: 10 })
    stream.on('open', () => opens.push(Date.now()))
    stream.on('disconnect', ({ reason }) => disconnects.push(reason))
    stream.start()
    await waitFor(() => opens.length >= 2)
    expect(disconnects[0]).toBe('stream ended')
    expect(stream.isConnected()).toBe(true)
  })

  it('keeps retrying while the server refuses, without emitting events', async () => {
    let attempts = 0
    const base = await listen((_req, res) => {
      attempts += 1
      res.writeHead(401).end()
    })
    const events: LiveBusEvent[] = []
    stream = new SseStream({ url: `${base}/event`, headers: {}, initialBackoffMs: 10, maxBackoffMs: 20 })
    stream.on('event', event => events.push(event))
    stream.start()
    await waitFor(() => attempts >= 3)
    expect(events).toEqual([])
    expect(stream.isConnected()).toBe(false)
  })

  it('stop() aborts the open stream and stops reconnecting', async () => {
    let connections = 0
    const base = await listen((_req, res) => {
      connections += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"type":"server.connected","properties":{}}\n\n')
    })
    stream = new SseStream({ url: `${base}/event`, headers: {}, initialBackoffMs: 10 })
    stream.start()
    await waitFor(() => stream!.isConnected())
    stream.stop()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(connections).toBe(1)
    expect(stream.isConnected()).toBe(false)
  })
})

describe('LiveServerClient', () => {
  it('reads the re-sync snapshot and posts answers to the recorded endpoints', async () => {
    const calls: Array<{ method: string; url: string; body: string }> = []
    const base = await listen((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        calls.push({ method: req.method ?? '', url: req.url ?? '', body })
        res.writeHead(200, { 'content-type': 'application/json' })
        if (req.url === '/session/status') res.end('{"ses_a":{"type":"busy"}}')
        else if (req.url === '/permission') res.end('[{"id":"per_1","sessionID":"ses_a","permission":"bash","patterns":["ls"]}]')
        else if (req.url === '/question') res.end('[]')
        else res.end('true')
      })
    })
    const client = new LiveServerClient({ baseUrl: base, username: 'opencode', password: 'pw', directory: '/p' })
    const { snapshot, failures } = await client.readResyncSnapshot()
    expect(failures).toEqual([])
    expect(snapshot.status).toEqual({ ses_a: { type: 'busy' } })
    expect(snapshot.permissions).toHaveLength(1)
    await client.replyPermission('per_1', 'once')
    await client.rejectQuestion('que_1')
    expect(calls.filter(c => c.method === 'POST').map(c => [c.url, c.body])).toEqual([
      ['/permission/per_1/reply', '{"reply":"once"}'],
      ['/question/que_1/reject', '{}'],
    ])
  })

  it('fails fast with the status code when the server refuses', async () => {
    const base = await listen((_req, res) => res.writeHead(401).end())
    const client = new LiveServerClient({ baseUrl: base, username: 'opencode', password: 'wrong', directory: '/p' })
    await expect(client.replyPermission('per_1', 'once')).rejects.toMatchObject({ status: 401 })
  })

  it('times out instead of hanging on a server that accepts but never answers', async () => {
    const base = await listen(() => {
      // Accept and never respond: the booting-instance behavior Stage 0 saw.
    })
    const client = new LiveServerClient({ baseUrl: base, username: 'opencode', password: 'pw', directory: '/p', timeoutMs: 100 })
    const started = Date.now()
    const { snapshot, failures } = await client.readResyncSnapshot()
    expect(snapshot).toEqual({})
    expect(failures).toHaveLength(3)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('keeps the parts of a re-sync that answered when one endpoint fails', async () => {
    const base = await listen((req, res) => {
      if (req.url === '/question') {
        res.writeHead(500).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(req.url === '/session/status' ? '{"ses_a":{"type":"busy"}}' : '[]')
    })
    const client = new LiveServerClient({ baseUrl: base, username: 'opencode', password: 'pw', directory: '/p' })
    const { snapshot, failures } = await client.readResyncSnapshot()
    // Status and permissions still apply; the failed domain is left out, not
    // reported as empty, so the projector keeps its own view of it.
    expect(snapshot).toEqual({ status: { ses_a: { type: 'busy' } }, permissions: [] })
    expect(failures).toEqual([expect.stringContaining('/question')])
  })
})
