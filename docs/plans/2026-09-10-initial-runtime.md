# opencode-terminal-headless — initial runtime plan

Status: P0–P5 implemented on `feat/initial-runtime`, package PR #1; durable
review follow-up on 2026-09-11. Agent Code issue #864 and PR #882 own host
integration. Changes remain uncommitted for the coordinating implementer.

The package adapts the native OpenCode TUI to Agent Code's committed records,
activity, semantic turns/phases and permission/question conditions. The caller
owns the PTY. `transcript/` owns committed records, `live/` owns bus state, and
`reconcile/SessionSequencer.ts` is the only layer that combines them. There is
no terminal screen mirror. Evidence is in `research/census-2026-09-10.md`.

## Constraints and revised decisions

- Node >=22.13.0, TypeScript Node16 modules, Vitest 4. Load `node:sqlite` through
  `process.getBuiltinModule` and local types so Agent Code's Node 20 typings
  still compile. `node-pty` is an optional peer; the package never spawns it.
- SQLite opens read-only. A realpath/device/inode generation pools connections;
  old leases survive replacement until released. Each read uses a transaction.
- Only `message.updated.1` and `message.removed.1` payloads are consumed.
  Unsupported versions of those fail closed. Other names/versions advance the
  cursor without parsing payloads; part events also wake held assistants.
- History reads the projection (including imported prefixes). Startup reads
  the head and history-owned user/completed-assistant ids in one snapshot so
  later rewrites cannot be recommitted. Incomplete assistants remain eligible.
- A user commits at its first answer, with earlier queued prompts first, or on
  a turn-end flush. Disconnected polling flushes a prompt after a full interval
  with no open assistant. Removed pending prompts are discarded.
- SessionProcessor assistants complete after their parts. Shell/subagent
  commands can complete before tool settlement: hold those entries in FIFO
  order until their tool settles. Committed entries are immutable.
- A live turn is one busy-to-idle span, potentially containing multiple prompts.
  Turn completion waits for durable drains/flushes and open/held assistants.
  At the 2 s deadline it uses partial text and may precede a late answer entry.
  Exit retries a busy final drain and reports `final_drain_incomplete` before
  `exit` if the deadline expires. Sink failures are contained and diagnosed.
- Loopback server, fresh per-spawn Basic-auth password in environment only.
  The TUI's child processes inherit it. Live reconnect re-reads status,
  permissions and questions. Descendant requests are relevant, child busy is
  not a parent turn. Live connection failures remain visible independently.
- Comments explain WHY beside decisions. Tests use independent recordings or
  hand-authored upstream contracts, observable synchronization and cleanup.
  System tests use real files/sockets/SQLite; live probes remain opt-in.

## Public API

The authoritative export list is `src/index.ts`; use its types rather than a
second hand-maintained declaration of all optional diagnostic/test settings.
This sketch includes the host operations added since the initial plan:

```ts
import {
  OpencodeTerminalHeadless, prepareOpencodeTerminalLaunch,
  resolveOpencodeDbPath, openOpencodeStore, opencodeTranscriptFile,
  type PtyLike, type OpencodeTerminalHeadlessOptions,
  type SubmitPromptOptions, type SubmitPromptResult,
} from 'opencode-terminal-headless'

// The host pre-creates the native session and spawns launch.binary/args/env.
const launch = await prepareOpencodeTerminalLaunch({
  binary, cwd, env, sessionID, dangerousMode,
})
// launch.dbPath is null (with dbPathError) if path resolution failed.
const options: OpencodeTerminalHeadlessOptions = { pty, cwd, launch }
const runtime = new OpencodeTerminalHeadless(options)
runtime.on('entry', record => consume(record)) // { info, parts }
runtime.on('semantic', event => consume(event))
runtime.on('activity', state => consume(state))
runtime.on('conditions', snapshot => consume(snapshot))
runtime.on('transcript-error', error => consume(error))
runtime.on('live-state', state => consume(state))
runtime.on('session-switched', event => consume(event)) // detect; host replaces
runtime.on('exit', event => consume(event))
await runtime.start()

runtime.write(bytes)
runtime.resize(cols, rows)
runtime.pasteAndSubmit(text) // native terminal input
const result: SubmitPromptResult = await runtime.submitPrompt(text, submitOptions)
runtime.getActivity()
runtime.getConditionSnapshot()
runtime.getLiveProgress()
runtime.getProviderSessionId()
await runtime.resolveConditionAction(action)
// Channels: runtime.semantic, runtime.screen, runtime.committed.
await runtime.stop()

const store = openOpencodeStore(dbPath) // typed OpencodeStoreError on refusal
try {
  store.readHistory(sessionID, { limit: 200, beforeMessageID })
  store.countMessages(sessionID)
  for (const record of store.iterateMessages(sessionID, { pageSize: 100 })) consume(record)
  store.readSessionInfo(sessionID)
  store.listSessions({ directory: cwd, limit: 100 }) // root-only; omit directory for global
  store.cursor(sessionID)
  store.read(tx => tx.eventsAfter(sessionID, afterSeq, 500))
} finally { store.release() }
opencodeTranscriptFile(sessionID) // opencode://session/<id>
await resolveOpencodeDbPath({ binary, env, cwd })
```

## Delivery checklist

- [x] P0: sibling scaffold, package scripts, optional PTY peer, Node floor,
  build/package gates and CI matrix `["22.13.0", "24"]`.
- [x] P1: read-only census, sanitized durable extraction, sandbox live probe,
  seven durable and six live recordings, five-table schema snapshot and findings.
- [x] P1 validator: `src/testing/fixtures.corpus.test.ts` checks replay against
  projection, sequence/status facts and capture/schema metadata. The package
  `scripts/check-test-contract.mjs` accepts `.corpus.test.ts`; core includes it.
- [x] P2: store, schema guard, committed assembler, live tail/fallback polling,
  history paging/forward traversal and removed-anchor continuation.
- [x] P3: SSE/auth/reconnect, live state projector, resync endpoints and conditions.
- [x] P4: sequencer, launch preparation, caller-owned PTY composition and public API.
- [x] P5: README, opt-in live test, package export checks and existing package PR.
- [x] Review: held tools, abort settlement, real BUSY drains/flushes/exit, throwing
  sink retention, startup rewrites, file generations and child-store lookup tests.
- [x] Review: fixture provenance, drift-watch review and measured coverage floors.
- [x] J2/J3 feature D request: root-only session listing, exact optional directory,
  newest-first ordering and timestamps. `session.time_created` is now required
  because this public query returns it, not because of the deleted child query.
- [x] Final verification for this follow-up: package `npx tsc --noEmit`,
  `npm run check`, `npm run test:coverage`, and Agent Code `npx tsc -b --pretty false`.
  All pass: 32 files / 294 tests, 18 mutation checks; coverage 93.79% statements,
  84.72% branches, 96.29% functions, 96.70% lines (floors 93/84/96/96).

The live test/probe is implemented but is not part of deterministic validation;
this follow-up does not run a real TUI. Mutation evidence and final command
counts are recorded in the coordinating review report. The parent reviews and
commits this work; no commit, branch switch, push or merge is part of this pass.
