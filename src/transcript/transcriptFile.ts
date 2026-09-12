// The locator a host publishes where file-backed providers publish a JSONL
// path: `opencode://session/<sessionID>`.
//
// WHY a URI instead of a path: OpenCode keeps every session in one shared
// database, so no file names a session. Hosts pass transcript locators through
// fields and tools built for paths (Agent Code's `jsonl-entry` file argument,
// its agent management MCP and its transcript tools). A scheme is
// unmistakable there: no filesystem path starts with `opencode://`, so a
// reader can branch on it without guessing, and a JSONL reader handed one
// fails on a missing file instead of misreading something.
//
// WHY the package owns both directions: the runtime mints the locator
// (`OpencodeTerminalHeadless.getTranscriptFile`), and every host reader must
// parse exactly that shape. Two hand-written copies of the format would drift.

const PREFIX = 'opencode://session/'

// OpenCode ids are opaque, but they are always one URL-safe segment. Anything
// with a separator, query or whitespace is not a locator this package minted.
const SESSION_SEGMENT = /^[^/?#\s]+$/

export function opencodeTranscriptFile(sessionID: string): string {
  return `${PREFIX}${sessionID}`
}

/** The session id in an `opencode://session/<id>` locator, or null for anything else. */
export function parseOpencodeTranscriptFile(file: string): string | null {
  if (!file.startsWith(PREFIX)) return null
  const sessionID = file.slice(PREFIX.length)
  return SESSION_SEGMENT.test(sessionID) ? sessionID : null
}
