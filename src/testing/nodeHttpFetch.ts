// A `fetch` built directly on node:http, for hosts that test this package
// inside a DOM-emulating environment.
//
// WHY this exists: DOM test environments (happy-dom, jsdom) replace the global
// `fetch` with their own implementation. Agent Code's renderer tests run under
// happy-dom, and its fetch is not the streaming, abortable client the live
// channel needs for a long-lived SSE response. OpencodeTerminalHeadless accepts
// an injected `fetch`, so a host's renderer-level integration test passes this
// one and gets real sockets regardless of what the environment put on
// globalThis.
//
// It implements only what the package uses: method, headers, a string body,
// an AbortSignal (including one that is already aborted), and a response with
// `ok`, `status`, `text()` and a WHATWG `body` stream. The response is a plain
// object rather than a `Response`, because a DOM environment's `Response` class
// may not accept a Node web stream as its body.

import { request } from 'node:http'
import { Readable } from 'node:stream'

type MinimalInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal | null
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

// Some DOM environments' AbortSignal lacks the static `timeout()` the package
// uses for its bounded requests. Tests that run the package under such an
// environment can call this once to restore the Node behavior.
export function ensureAbortSignalTimeout(): void {
  const signalClass = globalThis.AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }
  if (typeof signalClass.timeout === 'function') return
  signalClass.timeout = (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), ms).unref?.()
    return controller.signal
  }
}

export const nodeHttpFetch = ((input: string | URL, init: MinimalInit = {}) =>
  new Promise((resolve, reject) => {
    const signal = init.signal ?? null
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const url = new URL(String(input))
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers ?? {} }, res => {
      const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>
      let consumed = false
      resolve({
        ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
        status: res.statusCode ?? 0,
        get body() {
          consumed = true
          return body
        },
        async text() {
          if (consumed) throw new Error('body already consumed')
          consumed = true
          const chunks: Buffer[] = []
          for await (const chunk of res) chunks.push(Buffer.from(chunk as Buffer))
          return Buffer.concat(chunks).toString('utf8')
        },
      })
    })
    const onAbort = () => {
      req.destroy(abortError())
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('error', error => reject(error))
    req.on('close', () => signal?.removeEventListener('abort', onAbort))
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })) as unknown as typeof fetch
