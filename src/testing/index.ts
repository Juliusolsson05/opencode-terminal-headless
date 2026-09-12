// Test-support entry point: `opencode-terminal-headless/testing/index`.
//
// WHY this is exported for hosts: Agent Code's integration tests exercise its
// adapter against the same recorded OpenCode behavior this package is tested
// with — replaying real sessions over real sockets and a real SQLite file —
// instead of hand-writing a fake of OpenCode that would encode assumptions.
// It is source-only (excluded from the build by tsconfig.build.json) because
// its fixtures live in the repository, not in the published tarball; hosts
// that compile this package from source, as Agent Code does, can use it.

export { listDurableFixtures, listLiveFixtures, loadDurableFixture, loadLiveFixture, loadSchemaSql, type DurableFixture, type LiveFixture } from './fixtures.js'
export { createProjectionDatabase, LiveFixtureWriter } from './fixtureDatabase.js'
export { commitFacts, projectionRecord, type CommitFacts } from './oracle.js'
export { buildReplayScript, FakePty, playReplay, ReplayServer, sessionRowFor, settle, waitUntil, type ReplayStep } from './replay.js'
export { ensureAbortSignalTimeout, nodeHttpFetch } from './nodeHttpFetch.js'
