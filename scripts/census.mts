// Stage 0 census over a real OpenCode database, opened read-only.
//
// Usage:
//   npm run census -- --db ~/.local/share/opencode/opencode.db [--json out.json]
//   npm run census -- --db <path> --extract testing/fixtures/durable [--sessions ses_a,ses_b]
//
// WHY this script exists before any reader code: the durable reader decides
// WHEN a message is committed from the order of OpenCode's event rows. Those
// ordering rules are hypotheses until they are checked against every session a
// real user actually produced. Writing the reader first would test it against
// the shapes that happened to be in the author's head (see the Agent Code
// decomposition, docs/decomposition/opencode-terminal-headless.md, invariants
// 1–8). The census prints counts and opaque session ids only — never prompts,
// answers, tool output or paths.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadSqlite, type SqliteDatabase, type SqliteRow } from '../src/transcript/sqlite.js'
import { sanitize } from './lib/sanitize.mjs'

type Args = { db: string; json?: string; extract?: string; sessions?: string[] }

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--db' && value) { out.db = value; i += 1 }
    else if (flag === '--json' && value) { out.json = value; i += 1 }
    else if (flag === '--extract' && value) { out.extract = value; i += 1 }
    else if (flag === '--sessions' && value) { out.sessions = value.split(','); i += 1 }
  }
  if (!out.db) throw new Error('--db <path to opencode.db> is required')
  return out as Args
}

type DurableEvent = { seq: number; fullType: string; name: string; version: number; data: Record<string, unknown> }

type Info = Record<string, unknown> & { id?: string; role?: string; parentID?: string; finish?: string; time?: { created?: number; completed?: number }; error?: { name?: string } }
type Part = Record<string, unknown> & { id?: string; messageID?: string; type?: string; tool?: string; state?: { status?: string } }

type ShapeFlags = {
  reasoning: boolean
  toolCalls: boolean
  multiStep: boolean
  error: boolean
  abort: boolean
  compaction: boolean
  removed: boolean
  hasChildren: boolean
  isChild: boolean
  importedPrefix: boolean
  queuedPrompt: boolean
  userFileParts: boolean
  postCompletionPartUpdate: boolean
  postCompletionMessageUpdate: boolean
}

type SessionReport = {
  id: string
  version: string | null
  parentID: string | null
  events: number
  flags: ShapeFlags
  violations: Record<string, number>
}

function parseEvent(row: SqliteRow): DurableEvent {
  const fullType = String(row.type)
  const dot = fullType.lastIndexOf('.')
  const versionText = dot > 0 ? fullType.slice(dot + 1) : ''
  const version = /^\d+$/.test(versionText) ? Number(versionText) : NaN
  return {
    seq: Number(row.seq),
    fullType,
    name: Number.isNaN(version) ? fullType : fullType.slice(0, dot),
    version,
    data: JSON.parse(String(row.data)) as Record<string, unknown>,
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function without(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v
  return out
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter(k => stableStringify(before[k]) !== stableStringify(after[k])).sort()
}

const totals = {
  sessionsWithLog: 0,
  eventTypes: new Map<string, number>(),
  partTypes: new Map<string, number>(),
  toolNames: new Map<string, number>(),
  finishFinal: new Map<string, number>(),
  finishTurnEnding: new Map<string, number>(),
  stopMidTurn: 0,
  errorNames: new Map<string, number>(),
  messageUpdatesPerAssistant: new Map<number, number>(),
  postCompletionMessageUpdateKeys: new Map<string, number>(),
  postCompletionPartUpdateTypes: new Map<string, number>(),
  removedContexts: new Map<string, number>(),
  tableHasIdKeys: { messageRows: 0, messageWithId: 0, messageWithSessionID: 0, partRows: 0, partWithId: 0, partWithMessageID: 0, partWithSessionID: 0 },
  replay: { messagesEqual: 0, messagesDiffer: 0, messagesMissingInLog: 0, partsEqual: 0, partsDiffer: 0, partsMissingInLog: 0, differingMessageKeys: new Map<string, number>(), differingPartKeys: new Map<string, number>() },
  sessionUpdatedInfoKeys: new Map<string, number>(),
  userRewritesAfterCommit: 0,
  userRewriteKeys: new Map<string, number>(),
}

function bump<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

function analyseSession(db: SqliteDatabase, id: string, version: string | null, parentID: string | null, childParents: Set<string>): SessionReport {
  const events = db.prepare('SELECT seq, type, data FROM event WHERE aggregate_id = ? ORDER BY seq').all(id).map(parseEvent)
  const violations: Record<string, number> = {}
  const violate = (name: string) => { violations[name] = (violations[name] ?? 0) + 1 }
  const flags: ShapeFlags = {
    reasoning: false, toolCalls: false, multiStep: false, error: false, abort: false, compaction: false,
    removed: false, hasChildren: childParents.has(id), isChild: parentID !== null, importedPrefix: false,
    queuedPrompt: false, userFileParts: false, postCompletionPartUpdate: false, postCompletionMessageUpdate: false,
  }

  // Invariant 1: gapless seq from 0.
  events.forEach((event, index) => { if (event.seq !== index) violate('inv1_seq_gap_or_nonzero_start') })

  const infos = new Map<string, Info>()
  const parts = new Map<string, Part>()
  const roleOf = new Map<string, string>()
  const userPartMaxSeq = new Map<string, number>()
  const firstAssistantSeqForParent = new Map<string, number>()
  const completedAtSeq = new Map<string, number>()
  const completedInfo = new Map<string, Info>()
  const messageUpdateCount = new Map<string, number>()
  const userOrder: string[] = []
  const assistantsByParent = new Map<string, string[]>()
  // WHY queued prompts are detected from open assistants and not from "a user
  // row after a user row": OpenCode rewrites the user message (summary.diffs)
  // after the turn ends, so a role-sequence heuristic mistakes that rewrite
  // for a second prompt. A prompt is queued only when a NEW user message first
  // appears while some assistant message is still incomplete.
  const openAssistants = new Set<string>()

  for (const event of events) {
    bump(totals.eventTypes, event.fullType)
    // Invariant 6: every event in this aggregate names this session.
    const eventSession = typeof event.data.sessionID === 'string' ? event.data.sessionID : null
    if (eventSession !== null && eventSession !== id) violate('inv6_foreign_session_in_aggregate')

    if (event.name === 'message.updated') {
      const info = event.data.info as Info
      const mid = String(info.id)
      const role = String(info.role)
      roleOf.set(mid, role)
      bump(messageUpdateCount as Map<string, number>, mid)
      if (role === 'user' && !userOrder.includes(mid)) {
        if (openAssistants.size > 0) flags.queuedPrompt = true
        userOrder.push(mid)
      } else if (role === 'user' && firstAssistantSeqForParent.has(mid)) {
        // A user message rewritten after its first assistant exists — the
        // point where the durable reader has already committed it. Recorded
        // with the keys that moved so the reader's "ignore after commit"
        // rule is justified by what actually changes (expected: summary).
        totals.userRewritesAfterCommit += 1
        for (const key of changedKeys(infos.get(mid) ?? {}, info)) bump(totals.userRewriteKeys, key)
      }
      if (role === 'assistant') {
        if (info.time?.completed === undefined) openAssistants.add(mid)
        else openAssistants.delete(mid)
        const parent = String(info.parentID)
        if (!firstAssistantSeqForParent.has(parent)) firstAssistantSeqForParent.set(parent, event.seq)
        const list = assistantsByParent.get(parent) ?? []
        if (!list.includes(mid)) list.push(mid)
        assistantsByParent.set(parent, list)
        const wasCompleted = completedAtSeq.has(mid)
        if (info.time?.completed !== undefined && !wasCompleted) {
          completedAtSeq.set(mid, event.seq)
          completedInfo.set(mid, info)
        } else if (wasCompleted) {
          // Invariant 3b: message.updated after completion — record what moved.
          flags.postCompletionMessageUpdate = true
          violate('inv3b_message_update_after_completion')
          for (const key of changedKeys(completedInfo.get(mid) ?? {}, info)) bump(totals.postCompletionMessageUpdateKeys, key)
        }
        if (info.error) {
          flags.error = true
          const errName = String(info.error.name ?? 'unknown')
          bump(totals.errorNames, errName)
          if (errName === 'MessageAbortedError') flags.abort = true
        }
      }
      infos.set(mid, info)
    } else if (event.name === 'message.part.updated') {
      const part = event.data.part as Part
      const pid = String(part.id)
      const mid = String(part.messageID)
      bump(totals.partTypes, String(part.type))
      if (part.type === 'reasoning') flags.reasoning = true
      if (part.type === 'tool') { flags.toolCalls = true; bump(totals.toolNames, String(part.tool)) }
      if (part.type === 'compaction') flags.compaction = true
      const role = roleOf.get(mid)
      if (role === 'user') {
        userPartMaxSeq.set(mid, Math.max(userPartMaxSeq.get(mid) ?? -1, event.seq))
        if (part.type === 'file') flags.userFileParts = true
      }
      if (completedAtSeq.has(mid)) {
        // Invariant 3a: part update after its assistant completed.
        flags.postCompletionPartUpdate = true
        violate('inv3a_part_update_after_completion')
        bump(totals.postCompletionPartUpdateTypes, String(part.type))
      }
      parts.set(pid, part)
    } else if (event.name === 'message.removed') {
      flags.removed = true
      const mid = String(event.data.messageID)
      const role = roleOf.get(mid) ?? 'unknown'
      bump(totals.removedContexts, `${role}:${completedAtSeq.has(mid) ? 'completed' : 'incomplete'}`)
      infos.delete(mid)
      openAssistants.delete(mid)
    } else if (event.name === 'session.updated') {
      const info = (event.data.info ?? {}) as Record<string, unknown>
      for (const key of Object.keys(info)) bump(totals.sessionUpdatedInfoKeys, key)
    }
  }

  // Invariant 2: user parts precede the first assistant answering them.
  for (const [userId, maxSeq] of userPartMaxSeq) {
    const firstAssistant = firstAssistantSeqForParent.get(userId)
    if (firstAssistant !== undefined && maxSeq > firstAssistant) violate('inv2_user_part_after_first_assistant')
  }

  // Invariant 4: finish values, and which end a user turn.
  for (const [mid, count] of messageUpdateCount) {
    if (roleOf.get(mid) === 'assistant') bump(totals.messageUpdatesPerAssistant, count)
  }
  for (const [mid, info] of infos) {
    if (roleOf.get(mid) !== 'assistant') continue
    bump(totals.finishFinal, String(info.finish ?? '<none>'))
  }
  for (const [, assistants] of assistantsByParent) {
    if (assistants.length > 1) flags.multiStep = true
    const lastId = assistants[assistants.length - 1]
    const last = lastId ? infos.get(lastId) : undefined
    if (last) bump(totals.finishTurnEnding, String(last.finish ?? '<none>'))
    for (const mid of assistants.slice(0, -1)) {
      if (infos.get(mid)?.finish === 'stop') totals.stopMidTurn += 1
    }
  }

  // Invariants 7 and 8: replay vs projection, and which ids live in columns.
  const messageRows = db.prepare('SELECT id, data FROM message WHERE session_id = ?').all(id)
  const partRows = db.prepare('SELECT id, message_id, data FROM part WHERE session_id = ?').all(id)
  for (const row of messageRows) {
    const data = JSON.parse(String(row.data)) as Record<string, unknown>
    totals.tableHasIdKeys.messageRows += 1
    if ('id' in data) totals.tableHasIdKeys.messageWithId += 1
    if ('sessionID' in data) totals.tableHasIdKeys.messageWithSessionID += 1
    const replayed = infos.get(String(row.id))
    if (!replayed) { totals.replay.messagesMissingInLog += 1; flags.importedPrefix = true; continue }
    const lhs = without(replayed, ['id', 'sessionID'])
    if (stableStringify(lhs) === stableStringify(without(data, ['id', 'sessionID']))) totals.replay.messagesEqual += 1
    else {
      totals.replay.messagesDiffer += 1
      violate('inv7_message_replay_differs')
      for (const key of changedKeys(lhs, without(data, ['id', 'sessionID']))) bump(totals.replay.differingMessageKeys, key)
    }
  }
  for (const row of partRows) {
    const data = JSON.parse(String(row.data)) as Record<string, unknown>
    totals.tableHasIdKeys.partRows += 1
    if ('id' in data) totals.tableHasIdKeys.partWithId += 1
    if ('messageID' in data) totals.tableHasIdKeys.partWithMessageID += 1
    if ('sessionID' in data) totals.tableHasIdKeys.partWithSessionID += 1
    const replayed = parts.get(String(row.id))
    if (!replayed) { totals.replay.partsMissingInLog += 1; continue }
    const lhs = without(replayed, ['id', 'sessionID', 'messageID'])
    const rhs = without(data, ['id', 'sessionID', 'messageID'])
    if (stableStringify(lhs) === stableStringify(rhs)) totals.replay.partsEqual += 1
    else {
      totals.replay.partsDiffer += 1
      violate('inv7_part_replay_differs')
      for (const key of changedKeys(lhs, rhs)) bump(totals.replay.differingPartKeys, key)
    }
  }

  return { id, version, parentID, events: events.length, flags, violations }
}

function mapToObject<K extends string | number>(map: Map<K, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [String(k), v]))
}

async function extractFixtures(db: SqliteDatabase, dir: string, sessions: SessionReport[]): Promise<string[]> {
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const session of sessions) {
    const events = db.prepare('SELECT seq, type, data FROM event WHERE aggregate_id = ? ORDER BY seq').all(session.id)
    const messages = db.prepare('SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(session.id)
    const parts = db.prepare('SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY message_id, id').all(session.id)
    // The session row and sequence head are extracted so system tests can
    // build a database that satisfies the real foreign keys and the store's
    // session lookups. Every text column goes through the same sanitiser.
    const sessionRow = db.prepare('SELECT * FROM session WHERE id = ?').get(session.id) ?? {}
    const sequence = db.prepare('SELECT aggregate_id, seq, owner_id FROM event_sequence WHERE aggregate_id = ?').get(session.id) ?? null
    const fixture = {
      meta: {
        sessionID: session.id,
        parentID: session.parentID,
        opencodeVersion: session.version,
        flags: session.flags,
        source: 'local opencode.db, read-only census extraction',
        sanitised: 'free-text values replaced with <text:length>; keys, enums, ids, timestamps and tool names kept; non-public provider/model names aliased',
      },
      session: sanitize(Object.fromEntries(Object.entries(sessionRow).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]))),
      sequence: sequence && { aggregate_id: String(sequence.aggregate_id), seq: Number(sequence.seq), owner_id: sequence.owner_id == null ? null : String(sequence.owner_id) },
      events: events.map(row => ({ seq: Number(row.seq), type: String(row.type), data: sanitize(JSON.parse(String(row.data))) })),
      messages: messages.map(row => ({ id: String(row.id), time_created: Number(row.time_created), time_updated: Number(row.time_updated), data: sanitize(JSON.parse(String(row.data))) })),
      parts: parts.map(row => ({ id: String(row.id), message_id: String(row.message_id), time_created: Number(row.time_created), time_updated: Number(row.time_updated), data: sanitize(JSON.parse(String(row.data))) })),
    }
    const file = join(dir, `${session.id}.json`)
    await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`)
    written.push(file)
  }
  return written
}

// Pick the smallest session exhibiting each shape, so every observed shape is
// covered by at least one fixture while the corpus stays reviewable.
function selectCoverage(reports: SessionReport[]): SessionReport[] {
  const chosen = new Map<string, SessionReport>()
  const flagNames = Object.keys(reports[0]?.flags ?? {}) as Array<keyof ShapeFlags>
  const bySize = [...reports].sort((a, b) => a.events - b.events)
  for (const flag of flagNames) {
    const candidate = bySize.find(report => report.flags[flag])
    if (candidate) chosen.set(candidate.id, candidate)
  }
  // Always include the smallest plain session as a baseline.
  const plain = bySize.find(report => report.events > 3 && !Object.values(report.flags).some(Boolean))
  if (plain) chosen.set(plain.id, plain)
  return [...chosen.values()]
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(args.db, { readOnly: true })
  try {
    const aggregates = db.prepare(
      'SELECT es.aggregate_id AS id, s.version AS version, s.parent_id AS parentID FROM event_sequence es LEFT JOIN session s ON s.id = es.aggregate_id',
    ).all()
    const childParents = new Set(
      db.prepare('SELECT DISTINCT parent_id AS parentID FROM session WHERE parent_id IS NOT NULL').all().map(row => String(row.parentID)),
    )
    const reports = aggregates.map(row =>
      analyseSession(db, String(row.id), row.version == null ? null : String(row.version), row.parentID == null ? null : String(row.parentID), childParents),
    )
    totals.sessionsWithLog = reports.length

    const violationSessions: Record<string, { sessions: number; examples: string[] }> = {}
    for (const report of reports) {
      for (const name of Object.keys(report.violations)) {
        const entry = violationSessions[name] ?? { sessions: 0, examples: [] }
        entry.sessions += 1
        if (entry.examples.length < 3) entry.examples.push(report.id)
        violationSessions[name] = entry
      }
    }
    const flagCounts: Record<string, number> = {}
    for (const report of reports) for (const [flag, on] of Object.entries(report.flags)) if (on) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1

    const summary = {
      db: '<redacted path>',
      sessionsWithLog: totals.sessionsWithLog,
      violations: violationSessions,
      shapeFlags: flagCounts,
      eventTypes: mapToObject(totals.eventTypes),
      partTypes: mapToObject(totals.partTypes),
      toolNames: mapToObject(totals.toolNames),
      finishFinal: mapToObject(totals.finishFinal),
      finishTurnEnding: mapToObject(totals.finishTurnEnding),
      stopMidTurn: totals.stopMidTurn,
      errorNames: mapToObject(totals.errorNames),
      messageUpdatesPerAssistant: mapToObject(totals.messageUpdatesPerAssistant),
      postCompletionMessageUpdateKeys: mapToObject(totals.postCompletionMessageUpdateKeys),
      postCompletionPartUpdateTypes: mapToObject(totals.postCompletionPartUpdateTypes),
      removedContexts: mapToObject(totals.removedContexts),
      sessionUpdatedInfoKeys: mapToObject(totals.sessionUpdatedInfoKeys),
      userRewritesAfterCommit: totals.userRewritesAfterCommit,
      userRewriteKeys: mapToObject(totals.userRewriteKeys),
      tableHasIdKeys: totals.tableHasIdKeys,
      replay: {
        ...totals.replay,
        differingMessageKeys: mapToObject(totals.replay.differingMessageKeys),
        differingPartKeys: mapToObject(totals.replay.differingPartKeys),
      },
      coverageSelection: selectCoverage(reports).map(r => ({ id: r.id, events: r.events, flags: Object.entries(r.flags).filter(([, on]) => on).map(([f]) => f) })),
    }
    const text = JSON.stringify(summary, null, 2)
    if (args.json) await writeFile(args.json, `${text}\n`)
    console.log(text)

    if (args.extract) {
      const selected = args.sessions
        ? reports.filter(report => args.sessions?.includes(report.id))
        : selectCoverage(reports)
      const files = await extractFixtures(db, args.extract, selected)
      console.error(`wrote ${files.length} fixtures to ${args.extract}`)
    }
  } finally {
    db.close()
  }
}

await main()
