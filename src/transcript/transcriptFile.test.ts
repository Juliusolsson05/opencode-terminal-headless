import { describe, expect, it } from 'vitest'

import { opencodeTranscriptFile, parseOpencodeTranscriptFile } from './transcriptFile.js'

describe('the opencode:// transcript locator', () => {
  it('round-trips the session id the runtime mints', () => {
    expect(opencodeTranscriptFile('ses_2f1a9cE')).toBe('opencode://session/ses_2f1a9cE')
    expect(parseOpencodeTranscriptFile(opencodeTranscriptFile('ses_2f1a9cE'))).toBe('ses_2f1a9cE')
  })

  it('rejects filesystem paths and anything that is not exactly one session segment', () => {
    for (const other of [
      '/Users/me/.claude/projects/x/session.jsonl',
      'opencode://session/',
      'opencode://session/ses_1/extra',
      'opencode://session/ses_1?x=1',
      'opencode://session/ses 1',
      'opencode://sessions/ses_1',
      'OPENCODE://session/ses_1',
    ]) {
      expect(parseOpencodeTranscriptFile(other), other).toBeNull()
    }
  })
})
