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

import { execFile, type ExecFileException } from 'node:child_process'
import { delimiter, isAbsolute, sep } from 'node:path'

const memo = new Map<string, Promise<string>>()

// WHY twenty seconds for a command that answers in under one: the binary is a
// ~143 MB Bun single-file executable, and a restore that brings back panes at
// once starts several of them against a cold page cache. Measured on an idle
// machine: 0.37 s warm, 2.15 s cold.
//
// The budget is reachable, and has been reached twice — TWO separate incidents,
// which an earlier draft of this comment merged into one (review R2):
//   * 2026-09-20T22-51-32 run, ONE opencode pane, `provider.start.end` at
//     20087 ms — this budget plus overhead, on a single pane with nothing to
//     contend with but the machine itself;
//   * 2026-09-21T17-12-16 run, TWO panes, 24095 ms and 23830 ms, both released
//     in the same millisecond by the shared memo below.
// Healthy starts in the same logs are 4–2300 ms. In both, the pane then ran
// with a dark committed channel for the rest of the session — visible in
// feed-debug as turns completing with zero `jsonl_entries`.
//
// WHY it is not simply raised: a longer budget makes a genuinely broken install
// hang the pane for longer, and the lookup sits on the pane's startup path —
// `prepareOpencodeTerminalLaunch` awaits it before the TUI is spawned, so every
// second here is a second of empty pane. The transient case is handled where it
// belongs instead, by `OpencodeTerminalHeadless` retrying the lookup in the
// background once the storm has passed.
const DEFAULT_TIMEOUT_MS = 20_000

// Enough for a path plus any notice OpenCode prints before it. Named because
// `describeExecFailure` quotes it: a child that overruns this is stopped by
// Node with a STRING error code, which has to be told apart from a spawn
// failure that shares that shape (review R2-F4).
const MAX_OUTPUT_BYTES = 64 * 1024

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

/**
 * Say what actually went wrong, in a sentence a user can act on (#1114).
 *
 * WHY this exists instead of `error.message`: when a child is killed before it
 * printed anything, Node composes the message as `Command failed: <cmd>` and
 * appends an empty stderr. The result was a banner that said
 * "`… opencode db path` failed: Command failed: … opencode db path" and
 * nothing else: no exit code, no signal, no hint that a kill was involved at
 * all. Diagnosing it took the app's incident log (a `provider.start.end` of
 * 20087 ms against this file's 20000 ms budget) — the message itself carried
 * nothing.
 *
 * WHY `killed` is not the whole story, and the ordering that follows from it
 * (review R2-F2/F4, both confirmed against Node 24.14.1): `error.killed`
 * mirrors `child.killed`, which Node sets only when NODE ITSELF called
 * `child.kill()` — its timeout and maxBuffer paths. A child killed by anything
 * else (the OS reclaiming a ~143 MB Bun process under the memory pressure that
 * blew the budget in the first place, or a process-group kill at app shutdown)
 * arrives with `killed === false`, `code === null`, and the signal ONLY in
 * `error.signal`. Reading `killed` alone reproduced the exact useless message
 * this function exists to delete, so `signal` is checked in its own right.
 *
 * Nothing branches on the result — `recoverDbPath` retries every rejection
 * alike, and the ladder is what bounds a genuinely broken install. This is a
 * message for a human, not a classification for code.
 */
function describeExecFailure(
  error: ExecFileException,
  stderr: string,
  timeoutMs: number,
): string {
  const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join('; ')
  const suffix = detail ? `: ${detail}` : ''
  // Node's own timeout kill. `killed` alone would also catch the maxBuffer
  // kill, which is why that one is claimed first, below.
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    // The binary RAN and printed more than the cap; it may even have printed a
    // valid path. Keeping stderr matters here more than anywhere else, because
    // whatever is flooding the stream is the thing to go and look at.
    return `printed more than ${MAX_OUTPUT_BYTES} bytes and was stopped${suffix}`
  }
  if (error.killed) return `timed out after ${timeoutMs} ms and was killed with ${error.signal ?? 'SIGTERM'}${suffix}`
  // Killed from OUTSIDE Node: `killed` is false and the code is null, so the
  // signal is the only evidence there is. Naming it is the difference between
  // "the machine took this process away" and a silent mystery.
  if (error.signal) return `was killed from outside with ${error.signal}${suffix}`
  if (typeof error.code === 'number') return `exited with code ${error.code}${suffix}`
  // A string code that is not the maxBuffer one is a spawn-level failure
  // (ENOENT, EACCES, …): the command never ran, so there is no stderr to add.
  if (typeof error.code === 'string') return `could not be started (${error.code})`
  return `failed: ${error.message}${suffix}`
}

function run(options: ResolveDbPathOptions): Promise<string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.env)) if (typeof value === 'string') env[name] = value
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    execFile(
      options.binary,
      ['db', 'path'],
      { cwd: options.cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`\`${options.binary} db path\` ${describeExecFailure(error, stderr, timeoutMs)}`))
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
