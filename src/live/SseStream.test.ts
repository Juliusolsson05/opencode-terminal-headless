import { afterEach, describe, expect, it, vi } from 'vitest'

import { SseStream } from './SseStream.js'
import type { LiveBusEvent } from './types.js'

// Framing and reconnect timing with the transport fully controlled: a fake
// `fetch` hands the stream exactly the chunks a test chooses (so chunk
// boundaries are the test's, not the kernel's), and fake timers make the
// backoff schedule exact. The expected values are the SSE line rules (WHATWG
// HTML, "Server-sent events": CRLF, LF and lone CR all end a line; a blank
// line dispatches) and the stream's documented 250 ms → 2 s schedule.

afterEach(() => {
  vi.useRealTimers()
})

const encoder = new TextEncoder()

/** Run one connection over `chunks` and return every event it dispatched. */
async function eventsFrom(chunks: Uint8Array[]): Promise<LiveBusEvent[]> {
  const events: LiveBusEvent[] = []
  const stream = new SseStream({
    url: 'http://127.0.0.1:1/event',
    headers: {},
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })),
  })
  stream.on('event', event => events.push(event))
  const ended = new Promise<void>(resolve => stream.once('disconnect', () => resolve()))
  stream.start()
  await ended
  stream.stop()
  return events
}

// One event whose JSON spans two `data:` lines, CRLF line endings, and a
// multi-byte character so byte splits also cut through UTF-8 sequences.
const PAYLOAD = { type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' }, note: '日本語' } }
const JSON_TEXT = JSON.stringify(PAYLOAD)
const CUT = JSON_TEXT.indexOf('"properties"')
const CRLF_FRAME = `: keep-alive\r\n\r\ndata: ${JSON_TEXT.slice(0, CUT)}\r\ndata: ${JSON_TEXT.slice(CUT)}\r\n\r\n`

describe('SseStream framing', () => {
  it('yields the one event of a multi-line CRLF frame at every possible chunk split', async () => {
    const bytes = encoder.encode(CRLF_FRAME)
    const failures: number[] = []
    for (let split = 1; split < bytes.length; split += 1) {
      const events = await eventsFrom([bytes.slice(0, split), bytes.slice(split)])
      if (events.length !== 1 || JSON.stringify(events[0]) !== JSON_TEXT) failures.push(split)
    }
    // Every split point, including the ones between a CR and its LF (inside
    // the data lines and inside the terminating blank line), gives one event.
    expect(failures).toEqual([])
  })

  it('treats lone CR and LF line endings like CRLF, byte by byte', async () => {
    for (const eol of ['\r', '\n']) {
      const frame = `data: ${JSON_TEXT.slice(0, CUT)}${eol}data: ${JSON_TEXT.slice(CUT)}${eol}${eol}`
      const bytes = encoder.encode(frame)
      const events = await eventsFrom([...bytes].map(byte => new Uint8Array([byte])))
      expect(events).toEqual([PAYLOAD])
    }
  })

  it('dispatches back-to-back frames in one chunk and drops a final frame that never ended', async () => {
    const second = { type: 'session.idle', properties: { sessionID: 'ses_a' } }
    const text = `data: ${JSON_TEXT}\n\ndata: ${JSON.stringify(second)}\r\n\r\ndata: {"type":"never.finished"}\n`
    expect(await eventsFrom([encoder.encode(text)])).toEqual([PAYLOAD, second])
  })
})

describe('SseStream reconnect schedule', () => {
  it('retries at 250, 500, 1000 ms and then every 2 s, and stops retrying when stopped', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const stream = new SseStream({ url: 'http://127.0.0.1:1/event', headers: {}, fetch: async () => { attempts += 1; return new Response('', { status: 401 }) } })
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toBe(1)
    for (const delay of [250, 500, 1000, 2000, 2000, 2000]) {
      const before = attempts
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(attempts).toBe(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(before + 1)
    }
    stream.stop()
    expect(vi.getTimerCount()).toBe(0)
    const stopped = attempts
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toBe(stopped)
  })

  it('starts the schedule over after a connection that opened', async () => {
    vi.useFakeTimers()
    const answers = ['refuse', 'refuse', 'open-then-end', 'refuse', 'refuse']
    const at: number[] = []
    const stream = new SseStream({
      url: 'http://127.0.0.1:1/event',
      headers: {},
      fetch: async () => {
        at.push(Date.now())
        const answer = answers.shift() ?? 'refuse'
        if (answer === 'refuse') return new Response('', { status: 503 })
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }))
      },
    })
    const start = Date.now()
    stream.start()
    await vi.advanceTimersByTimeAsync(10_000)
    stream.stop()
    // Gaps: 250 and 500 while refused; the open resets to 250; then 500 again.
    const gaps = at.slice(1, 5).map((time, index) => time - at[index]!)
    expect(at[0]).toBe(start)
    expect(gaps).toEqual([250, 500, 250, 500])
  })
})
