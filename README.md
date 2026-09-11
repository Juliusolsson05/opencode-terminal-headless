# opencode-terminal-headless

Agent Code's PTY headless adapter for the **native OpenCode TUI**. It reads
OpenCode's durable event log and the TUI's own live server, and turns them into
the provider event stream Agent Code consumes from every agent.

## Should you use this package?

**Probably not.**

This package exists to adapt OpenCode to one consumer's shape: Agent Code's
headless provider contract. That is the same committed / semantic / screen
channel model `claude-code-headless` and `codex-headless` expose, with the same
turn, activity and condition events. It is built to match that shape and event
stream, not to be a pleasant general-purpose way to drive OpenCode.

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
- **One ordering rule.** When a turn ends, the durable log is drained first,
  so the committed answer always precedes `turn_completed`, the idle phase and
  inactive activity.

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
headless.on('transcript-error', error => {})            // a channel was disabled, and why
headless.on('live-state', ({ connected, reason }) => {})
headless.on('exit', ({ exitCode }) => {})
await headless.start()                                  // returns immediately; never waits for the server

headless.pasteAndSubmit('Explain this repository')      // bracketed paste + Enter, one write
await headless.resolveConditionAction(action)           // answer a permission / reject a question over HTTP
```

The class also exposes `semantic`, `screen` and `committed` channels in the
sibling packages' shape, plus `getActivity()`, `getConditionSnapshot()` and
`getProviderSessionId()`.

`openOpencodeStore(dbPath)` reads history without a running TUI:
`readHistory(sessionID, { limit, beforeMessageID })`. Agent Code uses it for
parked agents and MCP transcript reads.

## Degradation

The package degrades one channel at a time and always says so. It never
produces wrong data.

- **No database path, or a database it refuses** (schema gate, unknown event
  version): `transcript-error` with a code. Activity and conditions keep
  working.
- **The TUI's server never answers**: `live-state { connected: false, reason:
  'server-unreachable' }` after the connect deadline. The usual cause is a lost
  port race, which leaves the TUI neither exiting nor painting. Committed
  messages keep arriving through the durable poll.
- **A dropped connection**: reconnect with backoff, then re-sync status and
  pending requests. A turn that ended while nobody was listening is closed with
  its answer first.

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
  - Regenerate with `npm run census -- --db <opencode.db> --extract …` and
    `npm run probe:live`.
- **No oracle is the reader.** Durable tests check against OpenCode's own
  projection. Live tests check against each recording's own status events.
- **Replay harness.** `src/testing/` re-enacts recordings over a real socket
  and a real database. Hosts that compile this package from source (as Agent
  Code does) can import it from `opencode-terminal-headless/testing/index` to
  integration-test their adapters against the same behavior.

## License

[MIT](LICENSE)
