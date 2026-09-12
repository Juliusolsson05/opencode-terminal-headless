// The three channels, in the siblings' shape: each publish emits the named
// event and then `'event'`, synchronously. They carry no logic of their own —
// ordering is decided upstream by the SessionSequencer, and a channel only
// fans an already-ordered event out to listeners.
//
// WHY a screen channel with no screen: OpenCode Terminal deliberately has no
// headless xterm mirror (research/census-2026-09-10.md). The channel still
// exists so consumers that switch on channel kind see the same three channels
// as for Claude and Codex; it carries the "visible state" facts — activity and
// pending requests — which for OpenCode come from the live server instead.

import { EventEmitter } from 'node:events'

import type { CommittedEvent, ScreenEvent, SemanticEvent } from './types.js'

class Channel<E extends { type: string }> extends EventEmitter {
  publish(event: E): void {
    this.emit(event.type, event)
    this.emit('event', event)
  }
}

export class SemanticChannel extends Channel<SemanticEvent> {}
export class ScreenChannel extends Channel<ScreenEvent> {}
export class CommittedChannel extends Channel<CommittedEvent> {}
