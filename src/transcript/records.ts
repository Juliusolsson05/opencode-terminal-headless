// Row → record assembly: the one place that knows how OpenCode's projection
// rows become the `{ info, parts }` message record every consumer shares.
//
// WHY this exact shape: it is what OpenCode's own `GET /session/:id/message`
// and `opencode export` return, what the structured runtime already emits, what
// Agent Code's OpenCode transcript mapper folds, and what agent-transcript-
// parser decodes. Emitting it unchanged means no consumer needs a new decoder.
//
// WHY ids are re-attached here: OpenCode stores `id`/`sessionID`/`messageID`
// in columns and omits them from the JSON `data` (census invariant 8: 0 of
// 7,216 message rows and 29,263 part rows carry them). Consumers key on them,
// so assembly must restore them from the row, never trust `data` for them.

export type OpencodePartRecord = Record<string, unknown> & {
  id: string
  messageID: string
  sessionID: string
  type: string
}

export type OpencodeMessageInfo = Record<string, unknown> & {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  time: { created: number; completed?: number }
}

export type OpencodeMessageRecord = {
  info: OpencodeMessageInfo
  parts: OpencodePartRecord[]
}

export type MessageRow = { id: string; data: string }
export type PartRow = { id: string; data: string }

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Build one record, or `null` when the row is not a user/assistant message.
 * A null is a skip, not an error: OpenCode's projection is the authority and a
 * row this reader does not understand must not become a half-shaped record.
 */
export function buildMessageRecord(sessionID: string, message: MessageRow, parts: readonly PartRow[]): OpencodeMessageRecord | null {
  const data = parseObject(message.data)
  if (!data) return null
  const role = data.role
  if (role !== 'user' && role !== 'assistant') return null
  const time = (data.time ?? {}) as { created?: unknown; completed?: unknown }
  const info = {
    ...data,
    id: message.id,
    sessionID,
    role,
    time: { ...time, created: typeof time.created === 'number' ? time.created : 0 },
  } as OpencodeMessageInfo
  const partRecords: OpencodePartRecord[] = []
  for (const part of parts) {
    const partData = parseObject(part.data)
    if (!partData || typeof partData.type !== 'string') continue
    partRecords.push({ ...partData, id: part.id, messageID: message.id, sessionID, type: partData.type })
  }
  return { info, parts: partRecords }
}

export function isCompletedAssistant(record: OpencodeMessageRecord): boolean {
  return record.info.role === 'assistant' && typeof record.info.time.completed === 'number'
}
