import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { ensureAbortSignalTimeout, nodeHttpFetch } from './nodeHttpFetch.js'

// The four things the package asks of a `fetch`, over a real socket: a
// readable `text()`, a WHATWG `body` stream for the event bus, refusal of an
// already-aborted signal before any request goes out, and an in-flight abort
// that closes the connection. Expected values are the server's own view
// (what it received, whether its socket closed), never the fetch's.

let server: Server | null = null

afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = null
  }
})

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler)
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

describe('nodeHttpFetch', () => {
  it('sends method, headers and body, and reads the answer with text()', async () => {
    const received: Array<{ method?: string; header?: string; body: string }> = []
    const base = await listen((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        received.push({ method: req.method, header: String(req.headers['x-probe']), body })
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    const response = await nodeHttpFetch(`${base}/reply`, { method: 'POST', headers: { 'x-probe': 'yes' }, body: '{"reply":"once"}' })
    expect(response.status).toBe(201)
    expect(response.ok).toBe(true)
    expect(await response.text()).toBe('{"ok":true}')
    expect(received).toEqual([{ method: 'POST', header: 'yes', body: '{"reply":"once"}' }])
    // A body is read once: the stream and text() are the same bytes.
    await expect(response.text()).rejects.toThrow(/already consumed/)
  })

  it('exposes the response as a WHATWG stream that yields chunks as they are written', async () => {
    let flush: () => void = () => {}
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      flush = () => res.end('data: second\n\n')
    })
    const response = await nodeHttpFetch(`${base}/event`)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    expect(decoder.decode(first.value)).toBe('data: first\n\n')
    flush()
    let rest = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      rest += decoder.decode(value, { stream: true })
    }
    expect(rest).toBe('data: second\n\n')
  })

  it('rejects an already-aborted signal without opening a connection', async () => {
    let connections = 0
    const base = await listen((_req, res) => {
      connections += 1
      res.end()
    })
    const controller = new AbortController()
    controller.abort()
    await expect(nodeHttpFetch(`${base}/never`, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(connections).toBe(0)
  })

  it('aborts an in-flight request and the server sees its connection close', async () => {
    let closed = false
    const base = await listen((req, res) => {
      // Never answer: the abort is the only way this request ends.
      req.socket.on('close', () => { closed = true })
      res.on('close', () => { closed = true })
    })
    const controller = new AbortController()
    const pending = nodeHttpFetch(`${base}/hang`, { signal: controller.signal })
    // The abort must land after the request is on the wire.
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const deadline = performance.now() + 3000
    while (!closed && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(closed).toBe(true)
  })

  it('ensureAbortSignalTimeout leaves a working AbortSignal.timeout in place', () => {
    ensureAbortSignalTimeout()
    expect(typeof AbortSignal.timeout).toBe('function')
    expect(AbortSignal.timeout(1000).aborted).toBe(false)
  })
})
