import { describe, expect, it } from 'vitest'

import { prepareOpencodeTerminalLaunch } from './prepareLaunch.js'

// The launch contract: the TUI must expose its server on loopback with
// credentials the headless shares, without leaking the password into argv.

const base = {
  binary: '/opt/opencode',
  cwd: '/work',
  env: { PATH: '/bin', OPENCODE_SERVER_USERNAME: 'someone-else' },
  sessionID: 'ses_abc',
  allocatePort: async () => 51234,
  resolveDbPath: async () => '/data/opencode.db',
}

describe('prepareOpencodeTerminalLaunch', () => {
  it('builds loopback server args for the session and credentials only in env', async () => {
    const launch = await prepareOpencodeTerminalLaunch({ ...base, dangerousMode: false })
    expect(launch.args).toEqual(['--session', 'ses_abc', '--hostname', '127.0.0.1', '--port', '51234'])
    expect(launch.server.url).toBe('http://127.0.0.1:51234')
    expect(launch.env.OPENCODE_SERVER_PASSWORD).toBe(launch.server.password)
    // An inherited username would make the TUI authenticate as someone the
    // headless is not; it is always overwritten.
    expect(launch.env.OPENCODE_SERVER_USERNAME).toBe('opencode')
    expect(launch.args.join(' ')).not.toContain(launch.server.password)
    expect(launch.env.PATH).toBe('/bin')
    await expect(launch.dbPathPending).resolves.toBe('/data/opencode.db')
  })

  it('maps dangerous mode to OpenCode\'s --auto and nothing else', async () => {
    const launch = await prepareOpencodeTerminalLaunch({ ...base, dangerousMode: true })
    expect(launch.args[launch.args.length - 1]).toBe('--auto')
    expect(launch.args.filter(arg => arg.startsWith('--'))).toEqual(['--session', '--hostname', '--port', '--auto'])
  })

  it('mints a different password per launch', async () => {
    const a = await prepareOpencodeTerminalLaunch({ ...base, dangerousMode: false })
    const b = await prepareOpencodeTerminalLaunch({ ...base, dangerousMode: false })
    expect(a.server.password).not.toBe(b.server.password)
    expect(a.server.password.length).toBeGreaterThanOrEqual(32)
  })

  // agent-code#1114: the launch does not wait for `opencode db path` (a Bun
  // process with a 20 s budget that a restore storm has overrun). The TUI
  // never needs the path; the headless awaits `dbPathPending` itself.
  it('returns without waiting for the database-path lookup', async () => {
    const launch = await Promise.race([
      prepareOpencodeTerminalLaunch({ ...base, dangerousMode: false, resolveDbPath: () => new Promise<string>(() => {}) }),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 500)),
    ])
    expect(launch).not.toBe('hung')
    if (launch === 'hung') return
    expect(launch.dbPath).toBeNull()
    expect(launch.dbPathPending).toBeInstanceOf(Promise)
    expect(launch.args).toContain('--port')
  })

  it('hands a failed lookup to the headless as a rejected pending path, never an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const launch = await prepareOpencodeTerminalLaunch({ ...base, dangerousMode: false, resolveDbPath: () => { throw new Error('opencode not installed') } })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
      await expect(launch.dbPathPending).rejects.toThrow('opencode not installed')
      expect(launch.dbPath).toBeNull()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
