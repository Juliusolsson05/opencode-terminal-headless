# Upstream version support

`upstream-versions.json` records the OpenCode release this repo has
**explicitly accepted as supported** — meaning a human or agent has
reviewed the upstream release and confirmed this repo still works
against it.

This package is more drift-sensitive than its siblings: it reads
OpenCode's private SQLite schema and event log, and the TUI server's
bus vocabulary, none of which OpenCode promises to keep. The `notes`
in the JSON list exactly which surfaces are coupled and which of them
fail closed on their own.

## How drift is detected

`.github/workflows/upstream-watch.yml` runs daily. It calls
`scripts/check-upstream.mjs`, which fetches npm's `latest` dist-tag for
`opencode-ai` and compares it to `accepted`. If `latest` is newer, the
workflow opens (or updates) one rolling maintenance issue.

The automation **only detects drift**. It never reads changelogs,
guesses what broke, or edits this file. An open drift issue does not
imply a known breakage — it only means upstream moved.

## How to accept a new version

1. Read the upstream release notes linked in the drift issue.
2. Work through the issue's acceptance checklist: re-run the census
   (`npm run census -- --db <path>`) and the live probe
   (`npm run probe:live`) against the new release; check the schema
   gate, the consumed event versions, the assistant write orders and
   the bus payloads named in the JSON `notes`.
3. If a recorded shape changed, regenerate the affected fixtures (see
   `testing/fixtures/README.md`) and update
   `research/census-2026-09-10.md`, or write a new census document.
4. Bump `accepted` (and `checkedAt`) in a PR.
5. On the next run the bot sees no drift and closes the issue.

Bumping `accepted` is a deliberate human act. Do not bump it to silence
the bot without doing the review.
