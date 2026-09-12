# opencode-terminal-headless

Agent Code's PTY headless adapter for the **native OpenCode TUI**. It reads
OpenCode's durable event log and the TUI's own live server, and turns them into
the provider event stream Agent Code consumes from every agent.

## Should you use this package?

**Probably not.**

This package exists to adapt OpenCode to one consumer's shape: Agent Code's
headless provider contract. That is the same committed / semantic / screen
channel model `claude-code-headless` and `codex-headless` expose, and the same
semantic vocabulary (`turn_started`, `stream_phase`, `turn_completed`,
`api_error` with `source: 'opencode-sse'`) and condition snapshot
(`opencode.permission` / `opencode.question`). The instance events differ
where OpenCode differs: `activity` carries `{ active, status }` instead of a
label plus a separate `idle`, `entry` carries a committed `{ info, parts }`
record and publishes the `opencode://session/<id>` locator on the committed
channel, and there is no `event` union. It is built to match that shape and
event stream, not to be a pleasant general-purpose way to drive OpenCode.

If you are building your own OpenCode integration, use OpenCode's first-party
surface instead: `opencode serve`, its HTTP API, its SSE bus, or the official
SDK. They are closer to upstream and carry no adapter layer. If you need
Agent Code's provider shape but can do without the native TUI, the sibling
[`opencode-headless`](https://github.com/Juliusolsson05/opencode-headless)
package drives `opencode serve` directly.

Use this package when you run the real `opencode` TUI in a terminal pane and
still need to know, programmatically and in Agent Code's vocabulary, what it
is doing.

## What it reads, and why this way

The TUI is a full-screen OpenTUI application. Parsing its screen would be the
most expensive and the least reliable option. Instead the package reads two
channels OpenCode already has, each owning different signals:

| Signal | Channel | How |
|---|---|---|
| Committed messages (`{ info, parts }`) and history | **Durable**: OpenCode's SQLite database, opened **read-only** | Tails the per-session `event` log by `seq` cursor. Final message content comes from the `message`/`part` projection, read in the same transaction |
| Activity, turns, stream phases, permission/question requests | **Live**: the TUI's own HTTP/SSE server | The TUI is launched with `--hostname 127.0.0.1 --port <free>` and a per-spawn password; the package subscribes to `/event` and re-syncs on every reconnect |
| Screen | none | No headless terminal mirror at all |

- **No double sources.** Each signal has exactly one owner, so there is
  nothing to arbitrate.
- **No polling while connected.** OpenCode commits a durable row before it
  publishes the bus event, so a live event tells the durable reader "a readable
  row exists".
- **Cheap polling when disconnected.** With the live channel down, the durable
  reader polls a primary-key lookup once a second.
- **One ordering rule, with a bounded wait.** When a turn ends, the durable log
  is drained first, so the committed answer precedes `turn_completed`, the idle
  phase and inactive activity. The wait is bounded: if the database is still
  BUSY, or an assistant message is still incomplete, after 2 seconds the turn
  is completed anyway and the late entry is delivered when it commits. A turn
  is never held open forever to preserve the ordering — a stuck database would
  otherwise freeze the host's status forever.

Every rule is argued from recorded evidence: a census of real sessions and
sandboxed recordings of the real TUI. See
[`research/census-2026-09-10.md`](research/census-2026-09-10.md).

## Requirements

- **OpenCode ≥ 1.18.27.** Earlier versions do not keep the per-session event
  log. The package then reports why and runs with the durable channel off.
- **Node ≥ 22.13.0**, for `node:sqlite` without a flag. Electron 43 ships
  Node 24.
- **A caller-owned PTY.** The package never spawns or kills processes.
  [`node-pty`](https://github.com/microsoft/node-pty) is an optional peer; any
  object with `pid`, `write`, `resize` and `onExit` works.

## Usage

```ts
import { spawn } from 'node-pty'
import { OpencodeTerminalHeadless, prepareOpencodeTerminalLaunch } from 'opencode-terminal-headless'

// sessionID is an existing `ses_…` id (Agent Code pre-creates one with `opencode import`).
const launch = await prepareOpencodeTerminalLaunch({ binary: 'opencode', cwd, env, sessionID, dangerousMode: false })
const pty = spawn(launch.binary, launch.args, { name: 'xterm-256color', cols: 120, rows: 40, cwd, env: launch.env })

const headless = new OpencodeTerminalHeadless({ pty, cwd, launch })
headless.on('activity', ({ active, status }) => {})     // busy / idle, with a status label
headless.on('semantic', event => {})                    // turn_started, stream_phase, turn_completed, api_error
headless.on('entry', record => {})                      // committed { info, parts } message
headless.on('conditions', snapshot => {})               // opencode.permission / opencode.question
headless.on('transcript-error', error => {})            // durable failure or nonfatal sink/drain diagnostic
headless.on('live-state', ({ connected, reason }) => {}) // unreachable, reconnected, re-sync incomplete
headless.on('exit', ({ exitCode }) => {})
await headless.start()                                  // returns immediately; never waits for the server

await headless.submitPrompt('Explain this repository')  // waits for connection + re-sync, then HTTP acceptance
await headless.resolveConditionAction(action)           // answer a permission / reject a question over HTTP
```

The class also exposes `semantic`, `screen` and `committed` channels in the
sibling packages' shape, plus `getActivity()`, `getConditionSnapshot()` and
`getProviderSessionId()`. `submitPrompt(text, { timeoutMs? })` uses the bound
session's `/prompt_async` endpoint. It waits up to the connect deadline (30
seconds by default), including the request.

It sends the session's own `agent`, `model` and `variant`, read from the session
row OpenCode itself writes. **Omitting them would not preserve the user's
choice** — 1.18.30 resolves an absent `agent` to `Agent.defaultInfo()`, the
configured default, and then persists that over the session's selection, so a
prompt sent by a host would move a `plan` session to `build` and drop its model
variant. The known limit: the row records the selection last *used*, so a choice
changed in the TUI but not yet prompted with is not visible to us.

The result is `{ ok: true }` on HTTP acceptance, or `{ ok: false, reason, detail? }`:

| reason | meaning | safe to resend? |
|---|---|---|
| `no-live-channel` | never started, or stopped; no request existed | yes |
| `unreachable` | the request was never dispatched | yes |
| `unknown` | the POST was dispatched and its fate is unknown | **no** |
| `rejected` | the server answered non-2xx (status in `detail`) | no |

`unknown` is not a hedge. The route forks the prompt work before it
acknowledges, so a lost response can follow a prompt that is already running;
treating that as "did not happen" is how a caller submits a user's work twice.
It never pastes and never retries a POST itself; `pasteAndSubmit` remains
available for host terminal-composer interactions.
`getLiveProgress()` exposes connection and re-sync progress for diagnostics
and test synchronization.

`openOpencodeStore(dbPath)` reads history without a running TUI:
`readHistory(sessionID, { limit, beforeMessageID })` pages back from the
newest message, `iterateMessages(sessionID)` walks the whole session forward a
page at a time, and `countMessages(sessionID)` gives the total. Agent Code uses
them for parked agents and MCP transcript reads.
`listSessions({ directory?, limit })` lists resumable sessions newest-first —
root sessions only, because a task child is an implementation detail of its
parent's turn and is not something a user can resume. Omitting `directory`
lists every project, which is what a global "recent sessions" control needs.

OpenCode has no transcript file, so where file-backed providers publish a JSONL
path this package publishes `opencode://session/<id>`
(`getTranscriptFile()`). `parseOpencodeTranscriptFile(locator)` returns the
session id, or null for anything else, so a host can route a locator to the
store and everything else to its file reader.

## Degradation

The package degrades one channel at a time and always says so. It never
produces wrong data.

- **No database path, or a database it refuses** (schema gate, unknown event
  version, a real read failure): `transcript-error` with a code. Only the
  durable channel ever stops. Activity and conditions keep working.
- **A busy database** (another OpenCode process holding it, for example while
  recovering its WAL): retried with backoff, at open, at the starting cursor
  and on every read. Busy never stops the channel.
- **The TUI's server never answers**: `live-state { connected: false, reason:
  'server-unreachable' }` after the connect deadline. The usual cause is a lost
  port race, which leaves the TUI neither exiting nor painting. Committed
  messages keep arriving through the durable poll.
- **A TUI that exits with the log still behind**: the final drain gets the same
  bounded wait. If it cannot finish, `transcript-error` with
  `final_drain_incomplete` is emitted *before* `exit`, so the host knows the
  transcript it holds may be missing the last message rather than silently
  trusting it. Like `sink_failed` (a host listener that threw), this is a
  diagnostic, not a channel stop.
- **A dropped connection**: reconnect with backoff, then re-sync status and
  pending requests. A turn that ended while nobody was listening is closed with
  its answer first. Only the newest connection's re-sync is applied. If some
  re-sync endpoints fail, the parts that answered still apply, and
  `live-state { connected: true, reason: 'resync-incomplete: …' }` names the
  rest.

## Security notes

- **Loopback only.** The TUI's server binds `127.0.0.1`.
- **Basic auth with a fresh random password per spawn.** The password is passed
  only in the environment (never argv) and is never persisted.
- **Inherited by OpenCode's own children.** OpenCode's tools and MCP servers
  inherit the password. That grants them nothing new: they already act inside
  that session.
- **Read-only database access.** The package never writes OpenCode's database.

## Development

```bash
npm install
npm run check          # contract, typecheck, deterministic tests, build, pack verification
npm run test:core      # pure logic over recorded fixtures
npm run test:system    # real SQLite files, real sockets, full recorded replays
OPENCODE_TERMINAL_HEADLESS_LIVE=1 NODE_PTY_PATH=… npm run test:live   # the real TUI, sandboxed
```

- **Recorded evidence.**
  - `testing/fixtures/durable/` holds sanitised real sessions: keys, enums,
    ids and timestamps are kept, free text is replaced.
  - `testing/fixtures/live/` holds sandboxed TUI recordings.
  - Regenerate with
    `npm run census -- --db <opencode.db> --extract … --recorded-with <version>`
    and `npm run probe:live`. `--recorded-with` is required: a fixture's
    `meta.recordedWith` names the OpenCode CLI release **observed at capture** —
    not a guarantee about the build that wrote every historical row, which a
    database cannot tell us. No reliable version marker exists inside the file,
    so guessing it would quietly invalidate every upstream-drift comparison.
- **No oracle is the reader.** Durable tests check against OpenCode's own
  projection. Live tests check against each recording's own status events.
- **Replay harness.** `src/testing/` re-enacts recordings over a real socket
  and a real database, so a host can integration-test its adapter against the
  same behavior. It is **source-only and not published**: `dist/` never
  contains it (`tsconfig.build.json` excludes `src/testing/**`), and the
  package declares no `testing` entry point. Agent Code reaches it through a
  bundler and `tsconfig` alias that maps `opencode-terminal-headless/testing`
  to `src/testing/index.ts` of the checked-out submodule; any other host
  needs an equivalent alias into the source tree.

## License

[MIT](LICENSE)
