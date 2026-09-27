# Report a late recovery only after the reader positions (agent-code#1114 follow-up)

Short plan: bug with a known root cause, found by agent-code#1397 reviews b and c (steering q97).

## Outcome
`db_path_recovered_late` is emitted only once the durable reader has chosen its starting head. A host that heals by re-reading history on that report (Agent Code #1117) then reads everything behind the head, and no committed turn is lost silently.

## Root cause (at `7a009541`)
After the retry ladder recovers the database path, `openDurableAfterRecovery` sets `lateRecoveryUnreported`, and `openDurable` called `reportLateRecovery()` right after `reader.start()`. A BUSY first cursor read makes `start()` return before positioning (`DurableReader.position` schedules a retry). So the host's one heal ran, a turn committed before the positioning retry landed behind the new head, and there was no second report. The #10 delivery gate already waits for `onPositioned`; the report did not.

## Change
- `openDurable` no longer reports after `start()`.
- `onReaderPositioned` makes every late-recovery report, both the launch-window one and the ladder's, after the head is chosen.

## Test
`OpencodeTerminalHeadless.degradation.system.test.ts`, real SQLite replay rig: pending path → ladder recovery → the store opens with BUSY positioning reads → a recorded turn is committed → reads succeed. The report must not arrive before a successful read, and must arrive exactly once after it. Red at `7a009541` (the report arrived with zero successful reads).

## Review round 1 (b and c: MERGE-READY)
- **c (survivor):** a late-recovery report from the reader's error path survived the suite. Pinned: when the recovered store's first positioning read fails permanently, the log shows `db_path_retrying` and `read_failed`, and no `db_path_recovered_late`. The test fails with that mutation applied.
