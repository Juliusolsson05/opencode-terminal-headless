// LiveServerClient — the few HTTP calls the live channel makes against the
// TUI's own server: re-sync reads after every (re)connect, and answers to
// permission/question requests and asynchronous prompt submission. Endpoint shapes are pinned by Stage 0
// recordings of OpenCode 1.18.30.
//
// WHY every call has a timeout: while the TUI's project instance boots, the
// server accepts connections and answers nothing (Stage 0 observed a 300 s
// stall at undici's default header timeout). A condition answer that hangs for
// minutes is worse than one that fails fast and lets the user answer in the TUI.
//
// WHY 10 s and not less: a booted instance answers these loopback reads in
// tens of milliseconds (the recordings' re-sync GETs complete 25–80 ms apart,
// sequentially), so 10 s is two orders of magnitude of headroom for a loaded
// machine. It is short enough that a user who clicked "Allow" learns within
// seconds that the answer did not land, while the TUI still shows the prompt
// they can answer directly. A re-sync read that times out is retried by the
// composition (OpencodeTerminalHeadless.runResync), so a short timeout costs a
// retry, never a lost reconciliation.

import type { LiveResyncSnapshot } from './types.js'

export type PermissionReply = 'once' | 'always' | 'reject'

/** The three independently fetched parts of a re-sync. */
export type ResyncPart = 'status' | 'permissions' | 'questions'

export const RESYNC_PARTS: readonly ResyncPart[] = ['status', 'permissions', 'questions']

const PART_PATH: Record<ResyncPart, string> = {
  status: '/session/status',
  permissions: '/permission',
  questions: '/question',
}

export type ResyncRead = {
  /** Only the parts that answered; a failed part is absent, never empty. */
  snapshot: Partial<LiveResyncSnapshot>
  /** Human-readable failures, one per failed part, for `live-state`. */
  failures: string[]
  /** Which parts failed, so the caller can retry exactly those. */
  failedParts: ResyncPart[]
}

export type LiveServerClientOptions = {
  baseUrl: string
  username: string
  password: string
  directory: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export class LiveServerRequestError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message)
    this.name = 'LiveServerRequestError'
  }
}

export class LiveServerClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly options: LiveServerClientOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  /** Headers every request (and the SSE stream) must carry. */
  headers(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`,
      // The server is multi-instance by directory; the TUI's session lives in
      // the instance for its cwd.
      //
      // WHY percent-encoded: fetch header values are ByteStrings, so a raw
      // `/tmp/项目` throws before a single byte is sent and the pane's live
      // channel never comes up. The server decodes the header with
      // `decodeURIComponent` (sst/opencode@v1.18.30
      // packages/opencode/src/server/routes/instance/middleware.ts, and the
      // HttpApi path's instance-context.ts), and the official SDK encodes it
      // with `encodeURIComponent` (packages/sdk/js/src/v2/client.ts); the
      // installed 1.18.30 binary carries both halves. Encoding also keeps a
      // literal `%20` in a directory name from being decoded into a space and
      // selecting a different instance.
      'x-opencode-directory': encodeURIComponent(this.options.directory),
    }
  }

  eventUrl(): string {
    return new URL('/event', this.options.baseUrl).toString()
  }

  /**
   * Current status and pending requests, each endpoint on its own: a part
   * whose request failed is absent from `snapshot` and named in `failures`,
   * so one failing endpoint cannot discard the others. `parts` narrows the
   * read to what a retry still needs.
   */
  async readResyncSnapshot(parts: readonly ResyncPart[] = RESYNC_PARTS): Promise<ResyncRead> {
    const results = await Promise.allSettled(parts.map(part => this.request('GET', PART_PATH[part])))
    const read: ResyncRead = { snapshot: {}, failures: [], failedParts: [] }
    parts.forEach((part, index) => {
      const result = results[index]!
      if (result.status === 'rejected') {
        read.failedParts.push(part)
        read.failures.push(`${PART_PATH[part]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        return
      }
      const value = result.value
      if (part === 'status') {
        read.snapshot.status = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as LiveResyncSnapshot['status']) : {}
      } else {
        read.snapshot[part] = Array.isArray(value) ? value : []
      }
    })
    return read
  }

  async replyPermission(requestID: string, reply: PermissionReply): Promise<void> {
    await this.request('POST', `/permission/${encodeURIComponent(requestID)}/reply`, { reply })
  }

  async rejectQuestion(questionID: string): Promise<void> {
    await this.request('POST', `/question/${encodeURIComponent(questionID)}/reject`, {})
  }

  /**
   * sst/opencode@v1.18.30 packages/opencode/src/server/routes/instance/session.ts:
   * prompt_async omits sessionID from PromptInput because it is in the path.
   * Agent/model are deliberately absent: the server applies the same config,
   * session model and model.json recents as the TUI. Supplying defaults here
   * would silently override the user's selection. A 2xx is the acceptance
   * acknowledgement; there need not be a JSON response body (204 is normal).
   */
  async submitPrompt(sessionID: string, text: string, timeoutMs?: number): Promise<void> {
    await this.request('POST', `/session/${encodeURIComponent(sessionID)}/prompt_async`, { parts: [{ type: 'text', text }] }, { timeoutMs, acceptanceOnly: true })
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, options: { timeoutMs?: number; acceptanceOnly?: boolean } = {}): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(new URL(path, this.options.baseUrl), {
        method,
        headers: { ...this.headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      })
    } catch (error) {
      throw new LiveServerRequestError(null, `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok || options.acceptanceOnly) {
      // Status owns acceptance. Do not wait for an error/acknowledgement body
      // that a sick server may never finish, and release that response's
      // socket rather than leaving an unread stream behind.
      void response.body?.cancel().catch(() => {})
      if (!response.ok) throw new LiveServerRequestError(response.status, `${method} ${path} answered ${response.status}`)
      return null
    }
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
}
