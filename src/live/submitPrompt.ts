import { performance } from 'node:perf_hooks'

import { LiveServerRequestError, type LiveServerClient } from './LiveServerClient.js'

export type SubmitPromptOptions = { timeoutMs?: number }
export type SubmitPromptResult =
  | { ok: true }
  | { ok: false; reason: 'no-live-channel' | 'unreachable' | 'rejected'; detail?: string }

type Readiness = 'ready' | 'waiting' | 'closed'
type DeliveryOptions = {
  sessionID: string
  timeoutMs: number
  state: () => Readiness
  subscribe: (check: () => void) => () => void
}

/**
 * Wait on connection/re-sync changes, with one deadline for the wait AND the
 * POST. A booting TUI drops terminal input without an acknowledgement (#877),
 * so programmatic delivery must use its server and must never fall back to a
 * paste. A failed POST is not retried either: a lost response can follow an
 * accepted prompt, and retrying would submit the user's work twice.
 */
export async function submitLivePrompt(client: LiveServerClient, text: string, options: DeliveryOptions): Promise<SubmitPromptResult> {
  const deadline = performance.now() + options.timeoutMs
  while (options.state() !== 'ready') {
    if (options.state() === 'closed') return { ok: false, reason: 'no-live-channel' }
    const remaining = deadline - performance.now()
    if (remaining <= 0 || await waitForChange(options, remaining) === 'timeout') {
      return { ok: false, reason: 'unreachable', detail: 'Live channel did not connect and re-sync before the prompt deadline' }
    }
  }
  // The continuation runs after any synchronous host callbacks triggered by
  // re-sync. Re-read readiness above: a host may stop or disconnect the pane
  // in those callbacks before this promise gets its next turn.
  const remaining = Math.ceil(deadline - performance.now())
  if (remaining <= 0) return { ok: false, reason: 'unreachable', detail: 'Prompt deadline expired' }
  try {
    await client.submitPrompt(options.sessionID, text, remaining)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof LiveServerRequestError && error.status !== null ? 'rejected' : 'unreachable',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function waitForChange(options: DeliveryOptions, timeoutMs: number): Promise<'changed' | 'timeout'> {
  return new Promise(resolve => {
    let unsubscribe = () => {}
    const finish = (result: 'changed' | 'timeout') => {
      clearTimeout(timer)
      unsubscribe()
      resolve(result)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    // No polling loop: startup/reconnect/re-sync and stop already own the
    // state transitions. Each pending call owns exactly one timer, released
    // on either readiness, shutdown or its deadline.
    unsubscribe = options.subscribe(() => finish('changed'))
    if (options.state() !== 'waiting') finish('changed')
  })
}
