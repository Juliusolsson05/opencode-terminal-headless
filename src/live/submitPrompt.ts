import { performance } from 'node:perf_hooks'

import { LiveServerRequestError, type LiveServerClient, type PromptSelection } from './LiveServerClient.js'

export type SubmitPromptOptions = { timeoutMs?: number }

/**
 * Why there are four reasons and not three:
 *
 * `unreachable` and `unknown` used to be one value, and that conflation was a
 * real defect. The host turns a failure into a retry decision, and those two
 * cases are opposites: `unreachable` means the request never left, so retrying
 * is free; `unknown` means the POST was dispatched and we never learned its
 * fate, and OpenCode's route FORKS the prompt work before it answers — so the
 * model may already be running. Retrying there submits the user's work twice.
 *
 * The boundary is the hand-off to the transport, not the arrival of a
 * response. When we cannot tell, the answer is `unknown`: a false "it did not
 * land" costs duplicated work, while a false "we are not sure" costs one
 * manual check.
 *
 * Retry-safety is a property of the reason. Never re-derive it from `detail`,
 * which exists only for humans.
 */
export type SubmitPromptResult =
  | { ok: true }
  | { ok: false; reason: 'no-live-channel' | 'unreachable' | 'unknown' | 'rejected'; detail?: string }

type Readiness = 'ready' | 'waiting' | 'closed'
type DeliveryOptions = {
  sessionID: string
  timeoutMs: number
  state: () => Readiness
  subscribe: (check: () => void) => () => void
  /**
   * Resolved as late as possible, immediately before the POST: the user may
   * change agent or model in the TUI while we are still waiting to connect,
   * and the selection that matters is the one in force when the prompt is
   * actually sent.
   */
  selection: () => PromptSelection
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
  if (remaining <= 0) return { ok: false, reason: 'unreachable', detail: 'Prompt deadline expired before the request was sent' }
  try {
    await client.submitPrompt(options.sessionID, text, options.selection(), remaining)
    return { ok: true }
  } catch (error) {
    // Past this line the request was handed to the transport, so anything
    // other than an explicit HTTP status leaves acceptance genuinely unknown:
    // a timeout, a reset and a dropped response are indistinguishable from a
    // prompt the server accepted and is already running.
    if (error instanceof LiveServerRequestError && error.status !== null) {
      return { ok: false, reason: 'rejected', detail: error.message }
    }
    return {
      ok: false,
      reason: 'unknown',
      detail: `${error instanceof Error ? error.message : String(error)} — the server may have accepted this prompt; do not resend it blindly`,
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
