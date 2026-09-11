# opencode-terminal-headless — initial runtime plan

Status: P0–P5 implemented on `feat/initial-runtime`. Stage 0 findings are in
`research/census-2026-09-10.md` and changed three rules from this plan's first
draft:
- one live turn is a whole busy→idle span, not one assistant message
- a prompt commits at its first answer or the next queued prompt's answer
- the live channel needs a connect deadline

The integration suites (`*.system.test.ts`, the recorded replays) and the
opt-in live test against the real TUI were added at the user's request, so that
no layer is verified only against the author's own picture of OpenCode.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the PTY headless package that reads the native OpenCode TUI's channels into the provider event shape Agent Code consumes: committed `{ info, parts }` messages, activity, turns, stream phases, and permission/question conditions.

**Architecture:** The caller spawns the TUI with arguments from `prepareOpencodeTerminalLaunch` and passes the PTY in, the same way `claude-code-headless` takes a caller-owned PTY. Two readers, each owning different signals, feed one isolated sequencer:
- `transcript/` tails OpenCode's SQLite `event` log read-only by `seq` cursor and reads final message content from the `message`/`part` projection.
- `live/` subscribes to the TUI's own `/event` SSE bus, reached through `--port` plus a per-spawn password, for `session.status` and permission/question requests.

There is no screen mirror.

**Tech Stack:** TypeScript (Node16 modules), `node:sqlite` loaded through `process.getBuiltinModule`, fetch-based SSE, Vitest 4.

**Spec:** Agent Code `docs/decomposition/opencode-terminal-headless.md` (pipeline, owners, stages, unknowns, fixture plan). Agent Code issue #864. The integration side is Agent Code `docs/superpowers/plans/2026-09-10-opencode-terminal-headless.md`.

## Global Constraints

- **Node floor: 22.13.0**, the first release where `node:sqlite` needs no flag. CI matrix `["22.13.0", "24"]`. Agent Code runs this package inside Electron 43 (Node 24.18).
- **Never import types from `node:sqlite`.** Agent Code compiles this source against `@types/node` 20.19, which has no `node:sqlite` module. Load it with `process.getBuiltinModule('node:sqlite')` and cast to the local interface in `src/transcript/sqlite.ts`. Keep `@types/node` at `^20.19.43`, matching the siblings.
- **Never import `node-pty` from runtime code.** The PTY is caller-owned and typed by the structural `PtyLike` in `src/terminal/PtyBinding.ts`. `node-pty` is an optional peer; the probe and live test load it dynamically.
- **The database is opened read-only.** The package never writes OpenCode state.
- **Durable event types understood:** `session.created.1`, `session.updated.1`, `message.updated.1`, `message.part.updated.1`, `message.removed.1`. Any other version of a known type fails that session closed with `event_version_unsupported`. Unknown types are counted and skipped.
- **Semantic events carry `source: 'opencode-sse'`.** Condition kinds are `opencode.permission` / `opencode.question`. Custom action names are `opencode.permission.reply` (payload `{ requestID, reply }`) and `opencode.question.reject` (payload `{ questionID }`).
- **The server binds `127.0.0.1`.** Username `opencode`; password is 24 random bytes as base64url.
- **Committed file string:** `opencode://session/<ses_id>`.
- **Comments:** thick WHY comments. Tests follow the Agent Code testing standard: `*.test.ts` core, `*.system.test.ts` system, `*.live.test.ts` opt-in live.
- **Commit trailers:**
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VXcU2JMay6xCk8NKJ6cTgj
  ```

## File map

```
src/
├─ index.ts                       public exports only
├─ OpencodeTerminalHeadless.ts    composition; caller-owned PTY; flat events + channels
├─ launch/
│  ├─ prepareLaunch.ts            args/env/server/dbPath for one spawn
│  ├─ port.ts                     allocateLoopbackPort()
│  └─ dbPath.ts                   resolveOpencodeDbPath() (memoised `opencode db path`)
├─ terminal/PtyBinding.ts         PtyLike, exit/data subscription, write/resize/pasteAndSubmit
├─ transcript/
│  ├─ sqlite.ts                   local node:sqlite interface + loader
│  ├─ schema.ts                   schema gate
│  ├─ records.ts                  row → { info, parts } assembly
│  ├─ OpencodeStore.ts            shared read-only handle; readHistory, readCommitted, cursor
│  ├─ CommittedAssembler.ts       pure: WHEN a message is committed
│  └─ DurableReader.ts            doorbell + fallback poll around the store
├─ live/
│  ├─ SseStream.ts                fetch SSE + Basic auth + reconnect
│  ├─ LiveServerClient.ts         permission reply / question reject / re-sync lists
│  └─ LiveStateProjector.ts       pure: bus events → activity/turn/phase/pending requests
├─ reconcile/SessionSequencer.ts  THE isolated layer: ordering across both sources
├─ conditions/                    vendored core + permission/question modules
└─ channels/                      semantic / screen / committed (+ types)
scripts/  census.mts, probe-live.mts, check-test-contract.mjs, clean-dist.mjs, test-package.mjs
testing/fixtures/{durable,live}/  Stage 0 recordings (sanitised) + schema.sql
research/census-2026-09-10.md     Stage 0 findings
```

## Public API (the contract Agent Code consumes)

```ts
export type PtyLike = {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

export type OpencodeTerminalLaunch = {
  binary: string
  args: string[]                       // ['--session', id, '--hostname', '127.0.0.1', '--port', n, ...('--auto')]
  env: Record<string, string>          // caller env + OPENCODE_SERVER_USERNAME/PASSWORD
  sessionID: string
  server: { url: string; username: string; password: string }
  dbPath: string | null                // null when `opencode db path` fails → durable channel disabled
}
export function prepareOpencodeTerminalLaunch(opts: {
  binary: string; cwd: string; env: Record<string, string>; sessionID: string; dangerousMode: boolean
}): Promise<OpencodeTerminalLaunch>
export function resolveOpencodeDbPath(opts: { binary: string; env: Record<string, string | undefined> }): Promise<string>

export type OpencodePartRecord = Record<string, unknown> & { id: string; messageID: string; sessionID: string; type: string }
export type OpencodeMessageRecord = {
  info: Record<string, unknown> & { id: string; sessionID: string; role: 'user' | 'assistant'; time: { created: number; completed?: number } }
  parts: OpencodePartRecord[]
}
export type OpencodeStore = {
  readonly dbPath: string
  readHistory(sessionID: string, opts?: { limit?: number; beforeMessageID?: string }): { records: OpencodeMessageRecord[]; hasOlder: boolean }
  readSessionInfo(sessionID: string): { id: string; parentID: string | null; directory: string; title: string; timeUpdated: number } | null
  release(): void
}
export function openOpencodeStore(dbPath: string): OpencodeStore      // throws OpencodeStoreError { code }

export class OpencodeTerminalHeadless extends EventEmitter {
  constructor(opts: { pty: PtyLike; cwd: string; launch: OpencodeTerminalLaunch; fetch?: typeof fetch; now?: () => number })
  readonly semantic: SemanticChannel; readonly screen: ScreenChannel; readonly committed: CommittedChannel
  start(): Promise<void>; stop(): Promise<void>
  write(data: string): void; resize(cols: number, rows: number): void; pasteAndSubmit(text: string): void
  getActivity(): { active: boolean; status: string | null }
  getConditionSnapshot(): ProviderConditionSnapshot
  resolveConditionAction(action: ConditionCustomAction): Promise<{ ok: true } | { ok: false; reason: string; failedAtStep?: string }>
  getProviderSessionId(): string
}
// events: activity, entry, semantic, conditions, 'transcript-error', 'live-state', exit
```

---

### Task P0: Scaffold and contract (Stage 4, package side)

**Files:** `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `vitest.live.config.ts`, `.gitignore`, `scripts/{check-test-contract,clean-dist,test-package}.mjs` (copied from opencode-headless), `.github/workflows/{ci,release}.yml`, `src/index.ts` (empty export).

- [ ] Copy the sibling scaffold. Set `engines.node >=22.13.0`, CI `node-versions: '["22.13.0", "24"]'`, `peerDependencies: { "node-pty": "^1.0.0" }` with `peerDependenciesMeta.node-pty.optional: true`, and devDependencies `@types/node ^20.19.43`, `@vitest/coverage-v8 ^4.1.10`, `tsx ^4.23.1`, `typescript ^5.5.0`, `vitest ^4.1.10`.
- [ ] `npm install` (NODE_ENV=development), then `npm run test:contract && npm run typecheck`. Expected: exit 0.
- [ ] Commit `build(package): scaffold the package and its testing contract`.

### Task P1: Stage 0 — evidence corpus and census

**Files:** `scripts/census.mts`, `scripts/probe-live.mts`, `scripts/lib/sanitize.mts`, `testing/fixtures/schema.sql`, `testing/fixtures/durable/*.json`, `testing/fixtures/live/*.json`, `research/census-2026-09-10.md`.

- [ ] **Census** (`npm run census -- --db <path>`): opens the database read-only and, for every session with an `event_sequence` row, checks invariants 1–8 of the decomposition. It prints counts, the first three violating session ids per invariant, event type × version counts, finish values, and message.removed contexts. It never prints user content.
- [ ] **Durable fixture extraction** (`--extract <dir>`): picks sessions that cover each observed shape, reusing a covered shape only when no better candidate exists. Writes `{ meta, schemaVersion, events: [{seq,type,data}], messages: [{id, time_created, time_updated, data}], parts: [{id, message_id, time_created, time_updated, data}] }` with `sanitize()` applied. Sanitizing keeps keys, enums, ids, timestamps and tool names, and replaces free-text values with `<text:len>`.
- [ ] **Schema snapshot:** `testing/fixtures/schema.sql` = `sqlite3 .schema` output for the six tables Stage 1 reads.
- [ ] **Live probe** (`npm run probe:live -- --out testing/fixtures/live`):
  - **Sandbox:** temporary HOME/XDG, `env -i` plus PATH/TERM, `OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS` removed, a temporary git project, and `OPENCODE_CONFIG_CONTENT` = `{ "model": "opencode/big-pickle", "permission": { "bash": "ask" } }`.
  - **Launch:** `opencode import` of an empty session, then the TUI through node-pty with `--session --hostname 127.0.0.1 --port <free>` and a password.
  - **Record:** SSE with timestamps, plus a durable tail of the sandbox database with timestamps.
  - **Scenarios:**
    1. A plain prompt.
    2. A prompt that needs bash, answered "once" over HTTP.
    3. A prompt that needs bash, rejected.
    4. A question-tool prompt, rejected.
    5. A prompt queued while busy.
    6. A port-conflict launch.
    7. Auth: a request without a password must get 401.
  - Writes one JSON file per scenario.
- [ ] **Validator** (`testing/fixtures/validate.test.ts`, core): every durable fixture's last-write-wins replay equals its own projection rows, and every live fixture has a strictly increasing `seq` for durable rows plus at least one `session.status`.
- [ ] **Findings:** write `research/census-2026-09-10.md`. Revise the decomposition's Unknowns in Agent Code. **If any invariant fails in a way that changes a stage, stop and revise the decomposition before P2.**
- [ ] Commit `test(fixtures): record OpenCode durable and live evidence`.

### Task P2: Durable reader (Stage 1)

**Tests first**, from the fixtures:
- `transcript/records.test.ts`: row → record. `info = { ...data, id, sessionID }`; parts ordered by id, `{ ...data, id, messageID, sessionID }`.
- `transcript/CommittedAssembler.test.ts`: for each durable fixture, feed the type-filtered `message.updated.1` events with a projection lookup, and assert:
  - the committed ids equal the projection's completed assistant ids plus user ids, each exactly once, in seq order
  - a user message commits once the first assistant with `parentID === user.id` appears, or at `flush()`
  - updates after commit are ignored
  - `message.removed.1` is ignored (the planned default until the census says otherwise)
- `transcript/OpencodeStore.system.test.ts`:
  - load `schema.sql` plus a fixture into a temp database with a writable `DatabaseSync`, then open the store read-only
  - `readHistory` limit/before paging
  - rows appended after `cursor()` are returned by `readCommittedSince`
  - the schema gate rejects a database missing `event.seq`
  - a concurrent writer transaction does not make reads throw
- `transcript/DurableReader.system.test.ts`: the doorbell reads once per tick; the fallback poll runs only while `setLiveConnected(false)`.

**Implementation:**
- `sqlite.ts`: `loadSqlite(): SqliteModule`, typed as `{ DatabaseSync: new (path: string, opts: { readOnly: boolean; open?: boolean }) => SqliteDatabase }`.
- `schema.ts`: `assertSupportedSchema(db)` checks tables `session, message, part, event, event_sequence` and columns from `schema.sql`.
- `OpencodeStore.ts`: a ref-counted registry keyed by realpath. Each read runs inside `BEGIN`/`COMMIT` so the event cursor and projection rows come from one snapshot. Prepared statements:
  - `cursor`: `SELECT seq FROM event_sequence WHERE aggregate_id=?`
  - `events`: `SELECT seq,type,data FROM event WHERE aggregate_id=? AND seq>? AND type IN ('message.updated.1','message.removed.1','session.updated.1','session.created.1') ORDER BY seq LIMIT ?`, which uses `event_aggregate_type_seq_idx`
  - `message`: `SELECT id,time_created,data FROM message WHERE id=?`
  - `parts`: `SELECT id,data FROM part WHERE message_id=? ORDER BY id`
  - history window: `SELECT id,time_created,data FROM message WHERE session_id=? ORDER BY time_created DESC, id DESC LIMIT ?`
- `DurableReader.ts`: `ring()` (doorbell, coalesced with `queueMicrotask`), `drainNow()` (synchronous), `setLiveConnected(bool)` (starts or stops the 1 s poll of `cursor`), and callbacks `onRecords(records)` / `onError(err)`.
- [ ] Tests pass. Commit `feat(transcript): read committed OpenCode messages from the durable event log`.

### Task P3: Live reader (Stage 2)

**Tests first**, from the live fixtures:
- `live/LiveStateProjector.test.ts`: replaying each recording gives:
  - active from the first `busy` to the last `idle`, with no intermediate inactive state in the multi-step scenario
  - exactly one turn per busy→idle pair
  - the `stream_phase` sequence limited to `requesting|thinking|responding|tool-use|idle`, ending in `idle`
  - permission visible from asked to replied, and the question likewise
  - events for foreign sessions ignored
  - permission and question requests from descendant sessions kept
- `live/SseStream.system.test.ts`: a local HTTP server that emits SSE frames. It checks the Basic auth and `x-opencode-directory` headers, frame parsing (multi-line `data:`, comments, heartbeats), reconnect after the server drops the socket, and that `stop()` aborts.

**Implementation:** exact event names and payload paths come from `research/census-2026-09-10.md` (Stage 0 unknown 1). Re-sync on every (re)connect: `GET /session/status` for our session's status, then `GET /permission` and `GET /question` to rebuild pending requests.
- [ ] Tests pass. Commit `feat(live): project the TUI server's bus into activity, turns and requests`.

### Task P4: Sequencer, launch, conditions, composition (Stage 3)

**Tests first:**
- `reconcile/SessionSequencer.test.ts`, over the recorded live+durable interleavings:
  - on turn end, the sequencer calls `drainDurable()` before emitting `turn_completed`, `stream_phase idle` and activity idle, so the final assistant entry precedes idle
  - `turn_started`/`turn_completed` pair on one `turnId` and never overlap
  - while active, an activity heartbeat is re-emitted every 1000 ms (fake timers)
  - exit closes the open turn, clears conditions, and emits activity false exactly once
- `launch/prepareLaunch.test.ts`:
  - args and env shape
  - the password is never in args
  - `--auto` only when `dangerousMode`
  - `dbPath: null` (and no throw) when resolution fails
- `launch/port.system.test.ts`: the allocated port is bindable afterwards.
- `conditions/modules.test.ts`: permission and question inputs produce records with the exact structured-runtime state shapes and custom actions; module order is permission, then question.
- `OpencodeTerminalHeadless.test.ts`:
  - a fake PTY, a fake fetch/SSE and a temp-database store
  - `start()` does not wait for the server
  - `resolveConditionAction` posts to `/permission/:id/reply` or `/question/:id/reject` and optimistically clears the condition
  - `stop()` is idempotent before, during and after `start()`
  - `pasteAndSubmit` writes `\x1b[200~text\x1b[201~\r` in one write

**Implementation** follows the public API above.
- [ ] Tests pass. Commit `feat(runtime): compose the OpenCode Terminal headless session`.

### Task P5: README, live test, package gate

- [ ] **README:**
  - "Should you use this package? Probably not" positioning.
  - What it reads (the durable log, the live server) and why there is no screen mirror.
  - The support floor (1.18.27).
  - The security notes: loopback bind, per-spawn password, and that the password is inherited by the TUI's own child processes.
- [ ] `src/OpencodeTerminalHeadless.live.test.ts`, gated on `OPENCODE_TERMINAL_HEADLESS_LIVE=1`. It runs scenario 2 end to end through the public API in the sandbox.
- [ ] `npm run check` on Node 24, and on 22.13 if available.
- [ ] Push the branch and open the package PR: "feat(runtime): read the native OpenCode TUI through Agent Code's headless shape" (`Refs Juliusolsson05/agent-code#864`).
