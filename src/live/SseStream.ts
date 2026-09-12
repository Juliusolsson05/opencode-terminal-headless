// SseStream — a minimal, reconnecting reader of the TUI server's `/event` bus.
//
// WHY not the EventSource API or opencode-headless's client: EventSource
// cannot send an Authorization header, and every request to the TUI's server
// must carry Basic auth (Stage 0: 401 without it). Depending on
// opencode-headless for ~80 lines of framing would couple two independently
// released packages; the sibling headless packages are self-contained too.
//
// WHY reconnect with a capped backoff: the server comes up seconds after the
// TUI is spawned and may be unreachable for the whole life of a TUI that lost
// its port (Stage 0 port-conflict recording). The stream keeps trying at a
// modest cadence; the connect DEADLINE — deciding the pane is degraded — is
// the composition layer's call, not the transport's.

import { EventEmitter } from 'node:events'

import type { LiveBusEvent } from './types.js'

export type SseStreamOptions = {
  url: string
  headers: Record<string, string>
  fetch?: typeof fetch
  initialBackoffMs?: number
  maxBackoffMs?: number
}

export type SseStreamEvents = {
  open: []
  event: [LiveBusEvent]
  disconnect: [{ reason: string }]
}

export interface SseStream {
  on<K extends keyof SseStreamEvents>(event: K, listener: (...args: SseStreamEvents[K]) => void): this
  off<K extends keyof SseStreamEvents>(event: K, listener: (...args: SseStreamEvents[K]) => void): this
  emit<K extends keyof SseStreamEvents>(event: K, ...args: SseStreamEvents[K]): boolean
}

export class SseStream extends EventEmitter {
  private readonly fetchImpl: typeof fetch
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number
  private abort: AbortController | null = null
  private stopped = true
  private connected = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs: number

  constructor(private readonly options: SseStreamOptions) {
    super()
    this.fetchImpl = options.fetch ?? fetch
    this.initialBackoffMs = options.initialBackoffMs ?? 250
    this.maxBackoffMs = options.maxBackoffMs ?? 2000
    this.backoffMs = this.initialBackoffMs
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.abort?.abort()
    this.abort = null
    this.markDisconnected('stopped')
  }

  isConnected(): boolean {
    return this.connected
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const abort = new AbortController()
    this.abort = abort
    try {
      const response = await this.fetchImpl(this.options.url, {
        headers: { ...this.options.headers, accept: 'text/event-stream' },
        signal: abort.signal,
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`event stream answered ${response.status}`)
      }
      this.connected = true
      this.backoffMs = this.initialBackoffMs
      this.emit('open')
      await this.read(response.body)
      this.markDisconnected('stream ended')
    } catch (error) {
      this.markDisconnected(abort.signal.aborted ? 'stopped' : error instanceof Error ? error.message : String(error))
    }
    this.scheduleReconnect()
  }

  // WHY an incremental line parser instead of normalising line endings per
  // chunk: the SSE spec allows CRLF, LF and lone CR, and transport chunking is
  // arbitrary. The previous parser rewrote a chunk-final "\r" to "\n" before
  // it could see the next chunk; when that chunk began with the matching "\n"
  // the pair became "\n\n", ended the event early, and both halves of a
  // multi-line payload failed JSON parsing and were silently dropped. Here a
  // chunk-final CR only records that a leading LF in the next chunk belongs to
  // it, so every split point of a frame yields the same single event.
  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const frame = new SseFrameParser(data => this.dispatchData(data))
    for (;;) {
      const { value, done } = await reader.read()
      // A frame still open at end of stream is discarded, as the spec says:
      // without its blank line it is not known to be complete.
      if (done) return
      frame.push(decoder.decode(value, { stream: true }))
    }
  }

  private dispatchData(data: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
      this.emit('event', parsed as LiveBusEvent)
    }
  }

  private markDisconnected(reason: string): void {
    if (!this.connected) return
    this.connected = false
    this.emit('disconnect', { reason })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, delay)
    this.retryTimer.unref?.()
  }
}

/**
 * SSE line and event framing (WHATWG HTML, "Server-sent events",
 * interpreting an event stream), reduced to what the bus uses: `data` lines
 * joined by "\n" and dispatched at a blank line. `event`, `id` and `retry`
 * fields are ignored because OpenCode puts the event type inside the JSON
 * payload and never resumes by id. Exported for the framing tests only.
 */
export class SseFrameParser {
  private line = ''
  private data: string[] = []
  // The previous chunk ended in CR, so an LF opening the next chunk is the
  // second half of that CRLF and not a line of its own.
  private skipLeadingLF = false

  constructor(private readonly dispatch: (data: string) => void) {}

  push(text: string): void {
    let start = 0
    if (this.skipLeadingLF && text.length > 0) {
      if (text[0] === '\n') start = 1
      this.skipLeadingLF = false
    }
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]
      if (char !== '\r' && char !== '\n') continue
      this.line += text.slice(start, index)
      this.endLine()
      if (char === '\r') {
        if (index + 1 < text.length) {
          if (text[index + 1] === '\n') index += 1
        } else {
          this.skipLeadingLF = true
        }
      }
      start = index + 1
    }
    this.line += text.slice(start)
  }

  private endLine(): void {
    const line = this.line
    this.line = ''
    if (line === '') {
      // A blank line dispatches the event; an event with no data lines (only
      // comments such as ": keep-alive") dispatches nothing.
      if (this.data.length > 0) this.dispatch(this.data.join('\n'))
      this.data = []
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    if (field !== 'data') return
    const value = colon < 0 ? '' : line.slice(colon + 1)
    this.data.push(value.startsWith(' ') ? value.slice(1) : value)
  }
}
