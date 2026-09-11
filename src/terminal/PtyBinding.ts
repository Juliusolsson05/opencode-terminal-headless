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

/** Structural subset of node-pty's IPty that the package uses. */
export type PtyLike = {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): PtyDisposable
}

export class PtyBinding {
  private exitSubscription: PtyDisposable | null = null
  private exited = false

  constructor(private readonly pty: PtyLike) {}

  attach(onExit: (event: { exitCode: number; signal?: number }) => void): void {
    if (this.exitSubscription) return
    this.exitSubscription = this.pty.onExit(event => {
      if (this.exited) return
      this.exited = true
      onExit(event)
    })
  }

  detach(): void {
    this.exitSubscription?.dispose()
    this.exitSubscription = null
  }

  isExited(): boolean {
    return this.exited
  }

  get pid(): number {
    return this.pty.pid
  }

  write(data: string): void {
    if (this.exited) return
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
   * cannot interleave with other input between the text and its Enter. This is
   * the delivery Agent Code's terminal runtime already ships.
   */
  pasteAndSubmit(text: string): void {
    this.write(`\x1b[200~${text}\x1b[201~\r`)
  }
}
