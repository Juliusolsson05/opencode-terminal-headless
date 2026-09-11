// LiveServerClient — the few HTTP calls the live channel makes against the
// TUI's own server: re-sync reads after every (re)connect, and answers to
// permission/question requests. Endpoint shapes are pinned by Stage 0
// recordings of OpenCode 1.18.30.
//
// WHY every call has a timeout: while the TUI's project instance boots, the
// server accepts connections and answers nothing (Stage 0 observed a 300 s
// stall at undici's default header timeout). A condition answer that hangs for
// minutes is worse than one that fails fast and lets the user answer in the TUI.

import type { LiveResyncSnapshot } from './types.js'

export type PermissionReply = 'once' | 'always' | 'reject'

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
      'x-opencode-directory': this.options.directory,
    }
  }

  eventUrl(): string {
    return new URL('/event', this.options.baseUrl).toString()
  }

  /**
   * Current status and pending requests, each endpoint on its own: a part
   * whose request failed is absent from `snapshot` and named in `failures`,
   * so one failing endpoint cannot discard the others.
   */
  async readResyncSnapshot(): Promise<{ snapshot: Partial<LiveResyncSnapshot>; failures: string[] }> {
    const paths = ['/session/status', '/permission', '/question'] as const
    const [status, permissions, questions] = await Promise.allSettled(paths.map(path => this.request('GET', path)))
    const failures: string[] = []
    const settled = (result: PromiseSettledResult<unknown>, path: string): { value: unknown } | null => {
      if (result.status === 'fulfilled') return { value: result.value }
      failures.push(`${path}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
      return null
    }
    const statusPart = settled(status!, paths[0])
    const permissionsPart = settled(permissions!, paths[1])
    const questionsPart = settled(questions!, paths[2])
    const snapshot: Partial<LiveResyncSnapshot> = {}
    if (statusPart) {
      const value = statusPart.value
      snapshot.status = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as LiveResyncSnapshot['status']) : {}
    }
    if (permissionsPart) snapshot.permissions = Array.isArray(permissionsPart.value) ? permissionsPart.value : []
    if (questionsPart) snapshot.questions = Array.isArray(questionsPart.value) ? questionsPart.value : []
    return { snapshot, failures }
  }

  async replyPermission(requestID: string, reply: PermissionReply): Promise<void> {
    await this.request('POST', `/permission/${encodeURIComponent(requestID)}/reply`, { reply })
  }

  async rejectQuestion(questionID: string): Promise<void> {
    await this.request('POST', `/question/${encodeURIComponent(questionID)}/reject`, {})
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(new URL(path, this.options.baseUrl), {
        method,
        headers: { ...this.headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new LiveServerRequestError(null, `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    if (!response.ok) throw new LiveServerRequestError(response.status, `${method} ${path} answered ${response.status}`)
    if (!text) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
}
