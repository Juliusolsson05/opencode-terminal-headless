// Resolve where the installed OpenCode keeps its database.
//
// WHY ask OpenCode (`opencode db path`) instead of computing XDG paths: the
// location depends on XDG variables, `OPENCODE_DB`, and a release-channel
// suffix OpenCode applies itself (research/06 in opencode-headless). The CLI is
// the one authority that already knows all of them, and it is a documented
// command (`opencode db path` — "print the database path").
//
// WHY memoised: one call costs a Bun process start (~0.3–2 s), paid before
// every pane's TUI can spawn. Every pane on a machine shares the answer unless
// something that decides it differs. The key is exactly those inputs:
// - which executable runs (see `executableKey`): the default binary is the
//   bare name `opencode`, so PATH picks it, and two PATHs can pick two
//   installs with different data directories;
// - the variables that move the data directory (`LOCATION_KEYS`).
// Anything else in the environment is irrelevant and must not fragment it.
//
// Invalidation policy:
// - A failure is evicted at once, so the next pane asks again.
// - A success is kept for the life of the process. What it could miss is an
//   in-place replacement of the same executable by a build from another
//   release channel (the channel is compiled into the binary and suffixes the
//   file name: sst/opencode@v1.18.30 packages/opencode/src/storage/db.ts
//   `getChannelPath`). Noticing that would cost the Bun start this cache
//   exists to avoid, on every pane, for an event that needs a reinstall; the
//   host picks up the new answer on its next start.

import { execFile } from 'node:child_process'
import { delimiter, isAbsolute, sep } from 'node:path'

const memo = new Map<string, Promise<string>>()

// The variables that can move OpenCode's data directory (storage/db.ts reads
// OPENCODE_DB and OPENCODE_DISABLE_CHANNEL_DB; Global.Path.data follows
// XDG_DATA_HOME, else HOME).
const LOCATION_KEYS = ['HOME', 'XDG_DATA_HOME', 'OPENCODE_DB', 'OPENCODE_CHANNEL', 'OPENCODE_DISABLE_CHANNEL_DB'] as const

/**
 * The inputs that decide which file `execFile(binary)` executes, and nothing
 * more, so panes in different project directories still share one answer.
 */
function executableKey(binary: string, env: Record<string, string | undefined>, cwd: string | undefined): unknown[] {
  if (isAbsolute(binary)) return [binary]
  const directory = cwd ?? process.cwd()
  // A relative path with a separator is resolved against the child's cwd.
  if (binary.includes('/') || binary.includes(sep)) return [binary, directory]
  // A bare name is searched on PATH. An empty or relative PATH entry (".",
  // "node_modules/.bin") is resolved against the child's cwd, so then the cwd
  // decides too.
  const path = env.PATH ?? null
  const relativeEntry = (path ?? '').split(delimiter).some(entry => entry === '' || !isAbsolute(entry))
  return [binary, path, relativeEntry ? directory : null]
}

export type ResolveDbPathOptions = {
  binary: string
  env: Record<string, string | undefined>
  cwd?: string
  timeoutMs?: number
}

export function resolveOpencodeDbPath(options: ResolveDbPathOptions): Promise<string> {
  const key = JSON.stringify([...executableKey(options.binary, options.env, options.cwd), ...LOCATION_KEYS.map(name => options.env[name] ?? null)])
  let pending = memo.get(key)
  if (!pending) {
    pending = run(options)
    memo.set(key, pending)
    // A failure must not be cached forever: the next pane retries.
    pending.catch(() => memo.delete(key))
  }
  return pending
}

function run(options: ResolveDbPathOptions): Promise<string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.env)) if (typeof value === 'string') env[name] = value
  return new Promise((resolve, reject) => {
    execFile(
      options.binary,
      ['db', 'path'],
      { cwd: options.cwd, env, encoding: 'utf8', timeout: options.timeoutMs ?? 20_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`\`${options.binary} db path\` failed: ${error.message}`))
          return
        }
        // The last non-empty line is the path; OpenCode may print notices
        // (e.g. an upgrade hint) before it.
        const line = stdout.split(/\r?\n/).map(part => part.trim()).filter(Boolean).pop() ?? ''
        if (!isAbsolute(line)) {
          reject(new Error(`\`${options.binary} db path\` did not print an absolute path`))
          return
        }
        resolve(line)
      },
    )
  })
}

/** Test seam: forget memoised answers. */
export function clearDbPathCache(): void {
  memo.clear()
}
