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

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      // Normalise CRLF so a frame boundary is always "\n\n" (the SSE spec
      // allows \r\n, \n and \r line endings).
      buffer = buffer.replace(/\r\n?/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        this.dispatchFrame(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
    }
  }

  private dispatchFrame(frame: string): void {
    const data: string[] = []
    for (const line of frame.split('\n')) {
      // Comment lines (": keep-alive") and non-data fields carry nothing the
      // bus uses; OpenCode puts the event type inside the JSON payload.
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data.join('\n'))
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
