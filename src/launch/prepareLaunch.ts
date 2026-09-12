// Everything the caller needs to spawn one observable OpenCode TUI.
//
// This is the codex-headless `prepareCodexResumeRollout` slot: work that must
// happen BEFORE the PTY exists. The caller still spawns the PTY itself (the
// package never owns a process, like its siblings) with exactly these args and
// env, then hands the PTY and this launch to OpencodeTerminalHeadless.
//
// WHY the server flags: without `--hostname`/`--port` the TUI talks to its
// worker over in-process RPC and nothing outside can observe it. With them the
// worker serves real HTTP on loopback and the TUI connects to it with the
// same credentials (sst/opencode@v1.18.30 cli/cmd/tui.ts:233-249).
//
// WHY a fresh password per spawn, only in env: the server is on loopback but
// any local process could reach it; Basic auth closes that. The password never
// goes in argv (visible in `ps`) and is never persisted — agent panes respawn
// on restart, so there is nothing to resume. OpenCode's own child processes
// (tools, MCP servers) inherit it, which is no new capability: they already
// act inside that session.

import { randomBytes } from 'node:crypto'

import { resolveOpencodeDbPath } from './dbPath.js'
import { allocateLoopbackPort } from './port.js'

export const SERVER_HOSTNAME = '127.0.0.1'
export const SERVER_USERNAME = 'opencode'

export type OpencodeTerminalLaunch = {
  binary: string
  args: string[]
  env: Record<string, string>
  sessionID: string
  server: { url: string; username: string; password: string }
  /** Null when the database path could not be resolved; the durable channel is then disabled. */
  dbPath: string | null
  dbPathError?: string
}

export type PrepareLaunchOptions = {
  binary: string
  cwd: string
  env: Record<string, string>
  /** An existing `ses_…` id: Agent Code pre-creates fresh sessions via `opencode import`. */
  sessionID: string
  /** Maps to OpenCode's `--auto` (auto-approve permissions not explicitly denied). */
  dangerousMode: boolean
  allocatePort?: () => Promise<number>
  resolveDbPath?: (opts: { binary: string; env: Record<string, string>; cwd: string }) => Promise<string>
}

export async function prepareOpencodeTerminalLaunch(options: PrepareLaunchOptions): Promise<OpencodeTerminalLaunch> {
  const password = randomBytes(24).toString('base64url')
  const db = await (options.resolveDbPath ?? resolveOpencodeDbPath)({ binary: options.binary, env: options.env, cwd: options.cwd }).then(
    path => ({ path, error: undefined as string | undefined }),
    (error: unknown) => ({ path: null, error: error instanceof Error ? error.message : String(error) }),
  )
  // WHY the port is allocated last, after the db-path lookup and not beside
  // it: the probe port is released as soon as it is chosen, and the TUI binds
  // it only once it boots. Anything else on the machine can take it in
  // between, and a TUI that loses its port neither exits nor paints (Stage 0).
  // `opencode db path` runs a Bun child (0.3–2 s on a cold cache); allocating
  // after it keeps that time out of the window. The rest, until the TUI
  // binds, cannot be closed from here. A lost port is reported as
  // `live-state { reason: 'server-unreachable' }`.
  const port = await (options.allocatePort ?? allocateLoopbackPort)()
  const args = ['--session', options.sessionID, '--hostname', SERVER_HOSTNAME, '--port', String(port)]
  if (options.dangerousMode) args.push('--auto')
  return {
    binary: options.binary,
    args,
    env: {
      ...options.env,
      // Set both explicitly: an inherited OPENCODE_SERVER_USERNAME would
      // otherwise make the TUI authenticate as someone our client is not.
      OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
      OPENCODE_SERVER_PASSWORD: password,
    },
    sessionID: options.sessionID,
    server: { url: `http://${SERVER_HOSTNAME}:${port}`, username: SERVER_USERNAME, password },
    dbPath: db.path,
    ...(db.error ? { dbPathError: db.error } : {}),
  }
}
