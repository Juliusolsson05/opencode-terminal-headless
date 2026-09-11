// Resolve where the installed OpenCode keeps its database.
//
// WHY ask OpenCode (`opencode db path`) instead of computing XDG paths: the
// location depends on XDG variables, `OPENCODE_DB`, and a release-channel
// suffix OpenCode applies itself (research/06 in opencode-headless). The CLI is
// the one authority that already knows all of them, and it is a documented
// command (`opencode db path` — "print the database path").
//
// WHY memoised per binary + environment: one call costs a Bun process start
// (~0.3–2 s). Every pane on a machine shares the answer unless the binary or
// the variables that move the data directory differ.

import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

const memo = new Map<string, Promise<string>>()

// The variables that can move OpenCode's data directory. Anything else in the
// environment is irrelevant to the answer and must not fragment the cache.
const LOCATION_KEYS = ['HOME', 'XDG_DATA_HOME', 'OPENCODE_DB', 'OPENCODE_CHANNEL'] as const

export type ResolveDbPathOptions = {
  binary: string
  env: Record<string, string | undefined>
  cwd?: string
  timeoutMs?: number
}

export function resolveOpencodeDbPath(options: ResolveDbPathOptions): Promise<string> {
  const key = JSON.stringify([options.binary, ...LOCATION_KEYS.map(name => options.env[name] ?? null)])
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
