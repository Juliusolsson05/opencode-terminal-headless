// Fixture sanitiser for recordings taken from a real user's OpenCode database.
//
// WHY structure-preserving replacement instead of dropping fields: the durable
// reader's correctness depends on shape (which keys exist, which enums occur,
// how ids link records), never on prose. Replacing every free-text value with
// a length-class placeholder keeps every shape the census observed while making
// the fixtures safe to commit to a public repository.
//
// WHY an allowlist of string keys and not a denylist: an unknown string field
// that slips past a denylist leaks user content; an unknown string field that
// slips past an allowlist only becomes a placeholder. Failing closed is the
// only direction that is safe for someone else's transcripts.

// String-valued keys whose values are vocabulary or identifiers, not content.
const KEEP_STRING_KEYS = new Set([
  'type',
  'role',
  'status',
  'finish',
  'id',
  'sessionID',
  'messageID',
  'parentID',
  'callID',
  'tool',
  'providerID',
  'modelID',
  'mode',
  'agent',
  'reason',
  'version',
  'variant',
  'snapshot',
  'mime',
])

// OpenCode's own identifier shapes (ses_/msg_/prt_/evt_ …) and provider tool
// call ids. Keeping them intact preserves every cross-record link (a task
// tool part's child session id, a part's message id) without exposing content.
const ID_PATTERN = /^(?:ses|msg|prt|evt|call|toolu|per|que|tsk|fc)_[A-Za-z0-9_-]+$/

// Error class names such as MessageAbortedError are vocabulary the assembler
// must recognise; their messages are content and are replaced.
const ERROR_NAME = /^[A-Z][A-Za-z]*Error$/

// WHY provider and model names get their own treatment: they are vocabulary to
// the reader (it never branches on them) but they disclose which paid plans
// the recording user subscribes to. OpenCode's own public provider and free
// models are kept verbatim; every other value maps to a stable per-run alias
// so records that shared a provider still share one after sanitising.
const PUBLIC_PROVIDERS = new Set(['opencode'])
const PUBLIC_MODELS = /^(?:big-pickle|[a-z0-9.-]+-free)$/
const aliases = new Map<string, string>()

function alias(kind: 'provider' | 'model', value: string): string {
  if (kind === 'provider' ? PUBLIC_PROVIDERS.has(value) : PUBLIC_MODELS.test(value)) return value
  const key = `${kind}:${value}`
  let out = aliases.get(key)
  if (!out) {
    out = `${kind}-${[...aliases.keys()].filter(existing => existing.startsWith(`${kind}:`)).length + 1}`
    aliases.set(key, out)
  }
  return out
}

export function sanitize(value: unknown, key?: string, parentKey?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'providerID') return alias('provider', value)
    if (key === 'modelID' || (parentKey === 'model' && key === 'id')) return alias('model', value)
    if (key !== undefined && KEEP_STRING_KEYS.has(key)) return value
    if (ID_PATTERN.test(value)) return value
    if (key === 'name' && ERROR_NAME.test(value)) return value
    return `<text:${value.length}>`
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, key, parentKey))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = sanitize(childValue, childKey, key)
    }
    return out
  }
  return value
}
