// The thin PTY binding. The caller owns the process (spawn and kill), exactly
// like claude-code-headless and codex-headless; the package only observes exit
// and writes input.
//
// WHY there is no headless xterm here: the siblings mirror the screen because
// Claude's and Codex's state lives on it. OpenCode's does not (the live server
// carries it), and the 60 Hz snapshot churn is the most expensive thing the
// sibling packages do. Agent Code already keeps its own raw-byte replay buffer
// for attaching the visible terminal, so nothing here needs the bytes at all.

export type PtyDisposable = { dispose(): void }

export type PtyExitEvent = { exitCode: number; signal?: number }

/** Structural subset of node-pty's IPty that the package uses. */
export type PtyLike = {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable
  /**
   * Optional (node-pty has it). The binding only notes that the TUI produced
   * its FIRST output, never the bytes: see `outputSeen` (agent-code#1114).
   */
  onData?(listener: (data: string) => void): PtyDisposable
}

export class PtyBinding {
  private subscription: PtyDisposable | null = null
  private exitEvent: PtyExitEvent | null = null
  private listener: ((event: PtyExitEvent) => void) | null = null
  private delivered = false
  private detached = false
  private dataSubscription: PtyDisposable | null = null
  private firstOutput = false

  /**
   * Subscribes to the PTY's exit AT ONCE, not when the owner starts.
   *
   * WHY at construction: the PTY contract offers an exit subscription, not an
   * "already exited" query or a replay. A CLI that dies between the owner's
   * construction and its `start()` (bad arguments, a missing session) would
   * otherwise exit unobserved, and the owner would wait for a server that is
   * never coming. The exit is latched here and handed to the owner's listener
   * when it subscribes (`onExit`).
   */
  constructor(private readonly pty: PtyLike) {
    const subscription = pty.onExit(event => this.handlePtyExit(event))
    // A PTY may deliver an already-latched exit synchronously from inside
    // `onExit()`, before `subscription` is assigned. The handler has then
    // latched it, and the subscription is released here instead.
    if (this.exitEvent) subscription.dispose()
    else this.subscription = subscription
    // Only the first output matters, so the subscription is dropped on it.
    this.dataSubscription = pty.onData?.(() => {
      this.firstOutput = true
      this.dataSubscription?.dispose()
      this.dataSubscription = null
    }) ?? null
    if (this.firstOutput) {
      this.dataSubscription?.dispose()
      this.dataSubscription = null
    }
  }

  /**
   * Has the TUI produced any output yet? `'unknown'` when the PTY offers no
   * data subscription.
   *
   * WHY this is the ordering source for the launch window (agent-code#1114,
   * steering q94): OpenCode commits a message only once its TUI takes input,
   * and it takes input only after it has painted; programmatic delivery is
   * held separately. So "no output yet" is an in-process, ordered fact that
   * nothing can have been committed. A wall-clock message time is not: a
   * message created before launch can still be updated and completed later,
   * and clocks step backwards (#10 verification a and b).
   */
  outputSeen(): boolean | 'unknown' {
    if (this.firstOutput) return true
    return this.pty.onData ? false : 'unknown'
  }

  /**
   * Route the exit to `listener`. An exit that already happened is delivered
   * synchronously, inside this call; either way it is delivered exactly once,
   * and never after `detach()`.
   */
  onExit(listener: (event: PtyExitEvent) => void): void {
    if (this.detached || this.listener) return
    this.listener = listener
    this.deliver()
  }

  /** Stop observing without killing the process (the caller owns it). Idempotent. */
  detach(): void {
    this.detached = true
    this.listener = null
    this.subscription?.dispose()
    this.subscription = null
    this.dataSubscription?.dispose()
    this.dataSubscription = null
  }

  isExited(): boolean {
    return this.exitEvent !== null
  }

  /** Is the binding still subscribed to the PTY? Test seam for the retention fix. */
  isSubscribed(): boolean {
    return this.subscription !== null
  }

  get pid(): number {
    return this.pty.pid
  }

  write(data: string): void {
    if (this.exitEvent) return
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty.resize(cols, rows)
    } catch {
      // Layout transitions can report 0x0 for a frame; the next measurement
      // corrects it. Losing one resize is better than killing the agent.
    }
  }

  /**
   * Paste text into the TUI composer and submit it, as one write.
   *
   * WHY one write with bracketed paste: OpenCode's TUI distinguishes a paste
   * from keystrokes, so multi-line prompts stay one prompt, and a single write
   * cannot interleave with other input between the text and its Enter. This
   * remains available for the host's composer interactions; programmatic
   * delivery uses OpencodeTerminalHeadless.submitPrompt, because a booting
   * TUI can silently discard pasted input before the composer mounts.
   */
  pasteAndSubmit(text: string): void {
    this.write(`\x1b[200~${text}\x1b[201~\r`)
  }

  private handlePtyExit(event: PtyExitEvent): void {
    // A PTY reports exit once; a second report (a buggy wrapper, or a test
    // double) must not end the owner twice.
    if (this.exitEvent) return
    this.exitEvent = event
    // WHY release the PTY subscription as soon as the exit is latched: an
    // exited process has nothing more to report, and a host that retains
    // exited PTYs (for diagnostics or replay) would otherwise keep this
    // closure — and through it the owner's channels, projector and launch
    // environment — alive for as long as it keeps the PTY. Doing it here
    // rather than in the owner's teardown makes the release hold on every exit
    // path, natural exit included. Disposing from inside the PTY's own exit
    // callback is safe: node-pty's emitter (and FakePty) iterate a copy of
    // their listeners.
    this.subscription?.dispose()
    this.subscription = null
    this.deliver()
  }

  private deliver(): void {
    if (!this.exitEvent || !this.listener || this.delivered) return
    this.delivered = true
    this.listener(this.exitEvent)
  }
}
