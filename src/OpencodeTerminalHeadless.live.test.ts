import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import type { SemanticEvent } from './channels/types.js'
import type { ConditionCustomAction, ConditionSnapshot } from './conditions/core/contract.js'
import { prepareOpencodeTerminalLaunch } from './launch/prepareLaunch.js'
import { OpencodeTerminalHeadless } from './OpencodeTerminalHeadless.js'
import type { PtyLike } from './terminal/PtyBinding.js'
import { settle, waitUntil } from './testing/replay.js'
import type { OpencodeMessageRecord } from './transcript/records.js'

// The real thing: the installed `opencode` TUI in a throwaway HOME, driven
// through this package's public API exactly as Agent Code drives it. Opt-in,
// because it needs a real binary, network access to a free model and ~a minute.
//
//   OPENCODE_TERMINAL_HEADLESS_LIVE=1 [OPENCODE_BINARY=…] [NODE_PTY_PATH=…] npm run test:live
//
// Safety: never touches the user's OpenCode data or quota (isolated
// HOME/XDG, free `opencode/*` model), never upgrades the binary
// (OPENCODE_DISABLE_AUTOUPDATE), and never inherits
// OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS — the test needs a real permission prompt.

const execFileAsync = promisify(execFile)
const enabled = process.env.OPENCODE_TERMINAL_HEADLESS_LIVE === '1'
const binary = process.env.OPENCODE_BINARY ?? join(process.env.HOME ?? '', '.opencode/bin/opencode')
const model = process.env.OPENCODE_TERMINAL_HEADLESS_MODEL ?? 'opencode/big-pickle'

type PtyModule = { spawn(file: string, args: string[], options: Record<string, unknown>): PtyLike & { kill(signal?: string): void; onData(listener: (data: string) => void): { dispose(): void } } }

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.reverse()) await step()
  cleanup = []
})

describe('OpencodeTerminalHeadless against the real OpenCode TUI', () => {
  it.skipIf(!enabled || !existsSync(binary))(
    'reports a full turn with a permission answered through the package (needs OPENCODE_TERMINAL_HEADLESS_LIVE=1 and an installed opencode)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'oth-live-'))
      cleanup.push(() => rmSync(root, { recursive: true, force: true }))
      const home = join(root, 'home')
      const project = join(root, 'project')
      await execFileAsync('mkdir', ['-p', home, project])
      writeFileSync(join(project, 'README.md'), '# live test project\n')
      await execFileAsync('git', ['init', '-q'], { cwd: project })
      const env: Record<string, string> = {
        PATH: `${dirname(binary)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        XDG_DATA_HOME: join(home, '.local/share'),
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_STATE_HOME: join(home, '.local/state'),
        XDG_CACHE_HOME: join(home, '.cache'),
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ model, autoupdate: false, share: 'disabled', permission: { bash: 'ask' } }),
      }

      // Pre-create the session the way Agent Code does (`opencode import`).
      const sessionID = `ses_${randomUUID().replaceAll('-', '')}`
      const seed = join(root, 'seed.json')
      const now = Date.now()
      writeFileSync(seed, JSON.stringify({ info: { id: sessionID, slug: 'live', projectID: 'live', directory: project, path: '', title: 'live', version: '0.0.0-live', time: { created: now, updated: now } }, messages: [] }))
      await execFileAsync(binary, ['import', seed], { cwd: project, env })

      const launch = await prepareOpencodeTerminalLaunch({ binary, cwd: project, env, sessionID, dangerousMode: false })
      expect(launch.dbPath).toBe(join(home, '.local/share/opencode/opencode.db'))

      const ptyModule = createRequire(import.meta.url)(process.env.NODE_PTY_PATH ?? 'node-pty') as PtyModule
      const pty = ptyModule.spawn(launch.binary, launch.args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: project, env: launch.env })
      let painted = false
      let screenTail = ''
      pty.onData(data => {
        painted = true
        screenTail = (screenTail + data).slice(-20_000)
      })
      // On failure, say what the TUI showed and what the package emitted: a
      // live test that only says "timed out" teaches nothing.
      const diagnose = (label: string) => (error: unknown) => {
        // eslint-disable-next-line no-control-regex
        const text = screenTail.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\s+/g, ' ')
        console.log(`[live:${label}] emitted: ${order.join(' ')}`)
        console.log(`[live:${label}] tui: ${text.slice(-1500)}`)
        throw error
      }
      cleanup.push(async () => {
        try { pty.kill() } catch { /* already gone */ }
        await settle(300)
      })

      const headless = new OpencodeTerminalHeadless({ pty, cwd: project, launch })
      cleanup.push(() => headless.stop())
      const semantic: SemanticEvent[] = []
      const entries: OpencodeMessageRecord[] = []
      const order: string[] = []
      const activity: boolean[] = []
      let conditions: ConditionSnapshot<'opencode'> | null = null
      let connected = false
      headless.on('semantic', event => { semantic.push(event); order.push(event.type === 'stream_phase' ? `phase:${event.phase}` : event.type) })
      headless.on('entry', record => { entries.push(record); order.push(`entry:${record.info.role}`) })
      headless.on('activity', state => { activity.push(state.active); order.push(`activity:${state.active}`) })
      headless.on('conditions', snapshot => { conditions = snapshot })
      headless.on('live-state', state => {
        order.push(`live:${state.connected}${state.reason ? `:${state.reason}` : ''}`)
        if (state.connected) connected = true
      })
      headless.on('transcript-error', error => { throw new Error(`durable channel failed: ${error.code} ${error.message}`) })
      await headless.start()

      await waitUntil(() => connected, 120_000, 'TUI server').catch(diagnose('connect'))
      await waitUntil(() => painted, 30_000, 'first TUI paint').catch(diagnose('paint'))
      const paintedAt = Date.now()
      await settle(Number(process.env.OPENCODE_TERMINAL_HEADLESS_LIVE_GRACE_MS ?? 10_000))
      console.log(`[live] pasting ${Date.now() - paintedAt} ms after first paint`)

      headless.pasteAndSubmit('Use the bash tool to run the command `ls -1` in the current directory, then tell me how many entries it printed.')

      await waitUntil(() => Boolean(conditions?.conditions['opencode.permission']), 120_000, 'permission condition').catch(diagnose('permission'))
      const once = conditions!.conditions['opencode.permission']!.actions.find(action => action.label === 'Allow once') as ConditionCustomAction
      expect(await headless.resolveConditionAction(once)).toEqual({ ok: true })
      expect(conditions!.conditions['opencode.permission']).toBeUndefined()

      await waitUntil(() => semantic.some(event => event.type === 'turn_completed'), 150_000, 'turn end').catch(diagnose('turn end'))
      await settle(500)

      // Busy during the turn, idle after it.
      expect(activity[0]).toBe(true)
      expect(activity[activity.length - 1]).toBe(false)
      // The conversation, as committed records: the prompt and the answers.
      const prompt = entries.find(record => record.info.role === 'user')
      expect(prompt?.parts.some(part => part.type === 'text' && String(part.text).includes('ls -1'))).toBe(true)
      expect(entries.some(record => record.info.role === 'assistant' && typeof record.info.time.completed === 'number')).toBe(true)
      expect(entries.every(record => record.info.sessionID === sessionID)).toBe(true)
      // The order orchestration depends on.
      const completedAt = order.indexOf('turn_completed')
      expect(order.lastIndexOf('entry:assistant', completedAt)).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('phase:idle', completedAt)).toBeGreaterThan(completedAt)
      expect(order.indexOf('activity:false', completedAt)).toBeGreaterThan(completedAt)
    },
  )
})
