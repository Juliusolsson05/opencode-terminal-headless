# Launch the TUI without waiting on `opencode db path` (agent-code#1114)

Short plan: bug with a known root cause.

## Outcome
`prepareOpencodeTerminalLaunch` returns as soon as the port is allocated. The database-path lookup runs alongside the TUI's start instead of in front of it. Today it awaits `opencode db path` (a ~143 MB Bun process, flat 20 s budget) before allocating the port or spawning the PTY. So during a multi-pane restore every OpenCode pane stays blank for up to 20 s, even though the TUI never needs the path: only the durable (committed-transcript) channel does.

## Evidence (from agent-code#1114; do not re-derive)
- **Incident log:** `provider.start.end {opencode}` took 20,087 ms and 24,095 / 23,830 ms during restores (the lookup's 20 s timeout plus overhead). Healthy starts in the same log take 4–2,300 ms.
- **Direct measurement:** `opencode db path` answers in 0.37 s warm and 2.15 s cold on an idle machine. A restore starts several at once against a cold page cache.
- **Already landed (#6, #9):** the timeout is named, the memo evicts on rejection, a null path is retried by `OpencodeTerminalHeadless` on its own ladder (`resolveDbPath` option), and a late recovery is reported even when the first open is busy.
- **Remaining, per the issue's acceptance:** "Spawning the TUI does not wait on the db-path lookup."

## Design (contract)
- **`OpencodeTerminalLaunch`** gains `dbPathPending?: Promise<string>`: the lookup in flight at launch time.
  - `prepareOpencodeTerminalLaunch` starts it, does NOT await it, and returns `dbPath: null` with `dbPathPending` set.
  - A rejection handler is attached at once, so an unobserved failure is never an unhandled rejection.
  - `dbPath` / `dbPathError` keep their meaning for hosts that build a launch themselves: a string path, or null plus the reason.
- **`OpencodeTerminalHeadless.openDurable`:** with no `dbPath` but a `dbPathPending`, it awaits the pending lookup (once) before anything else.
  - Fulfilled with a path: open the store as before.
  - Rejected or empty: record the reason and enter the existing `recoverDbPath` ladder, which reports `db_path_retrying` / `db_path_unavailable` exactly as today.
  - **No diagnostic is reported while the first lookup is merely pending.** A normal cold lookup takes 0.4–2 s and must not flash a "retrying" banner on every pane.
  - Stop, exit and close fences apply to the continuation, as they do in the recovery ladder.
- **Ruling: the window the old order closed by construction.** `DurableReader.position()` seeds from the session's CURRENT head and treats everything before it as history the host has seen. Its own comment says this is safe for a fresh pane because "the TUI has not been given a prompt yet". That was true only because the lookup finished before the TUI spawned. With the lookup running alongside, rows the TUI commits before the reader positions would be dropped silently. The event log has no timestamps to position "at spawn time", and deriving the path without the CLI is rejected in `dbPath.ts` (the channel suffix is compiled into the binary). So:
  - **Programmatic delivery waits** (`submitPrompt`'s readiness) until the initial lookup has settled and the first open has been attempted, so the host's own prompts cannot land in the window. This is bounded by the existing delivery deadline, and a failed lookup releases the gate, because delivering is the product and the dark channel is reported separately.
  - **A turn the user starts in the TUI** before the reader positions (the `turn-start` live output) makes the eventual open report the existing `db_path_recovered_late` (the rows committed before it are missing; reload re-reads them). The gap is named, never silent.
  - Cost if wrong: a slow lookup delays an orchestration prompt by the lookup time (0.4–2 s typical, up to the 20 s budget), where before it delayed the whole pane by the same amount.
- **Port:** allocated immediately. The old comment put the port after the lookup to keep lookup time out of the port-bind race; with no lookup in front, that window is simply shorter.

## Tests
- **`prepareLaunch.test.ts`:** with a resolver that never settles, `prepareOpencodeTerminalLaunch` still resolves (red today: it hangs). With a rejecting resolver, it resolves with `dbPath: null` and a `dbPathPending` that rejects with the reason, and no unhandled rejection.
- **Headless:**
  - a launch whose `dbPathPending` fulfils after start opens the store once it lands, and reports no diagnostic before that;
  - one whose pending lookup rejects reports `db_path_retrying` and recovers through `resolveDbPath` as before;
  - a stop while it is pending opens nothing.
- The existing `dbPath`-string and `dbPath: null` + `dbPathError` launch tests stay green unchanged, so hosts building their own launch are unaffected.

## Verification boundary
Package tests drive the real headless with a fake PTY and store. The app side is a submodule pointer bump (with lockfile resync) in agent-code. The restore-storm timing is not reproduced here; the issue's incident log is the evidence.

## Out of scope
- The lookup's 20 s budget itself, and the resolver's memo; both are unchanged.

## Review round 1
- **b (blocker): the delivery gate opened when the lookup LANDED, not when the reader POSITIONED.** A BUSY first open, or a BUSY cursor read, deferred positioning, and a prompt sent in that gap was committed and skipped with no report.
  - `DurableReader` gains `onPositioned`, and the gate opens there.
  - It also opens on a permanent durable failure (a refused database, a reader error, a failed or empty lookup): delivering is the product, and a dark channel is reported on its own.
  - Test: a BUSY first open keeps delivery held until the retry positions.
- **b (major): the `turn-start` heuristic missed a turn that ran and finished before `/event` came up.**
  - **Ruling:** use database truth instead of live events. When the reader positions after a pending lookup, the newest message's `time.created` is compared with the launch time (the headless's clock at construction, right after spawn). Anything created at or after launch was committed in the window and is named through `db_path_recovered_late`. An unreadable check is reported too, since the gap cannot be ruled out.
  - The `turn-start` tracking is removed.
  - Tests use the headless's injectable `now`, because replayed rows carry the recording's times.
- **b (survivor):** an empty path from the pending lookup is reported as unavailable and releases delivery; pinned.
