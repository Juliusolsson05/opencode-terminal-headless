import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearDbPathCache, resolveOpencodeDbPath } from './dbPath.js'
import { allocateLoopbackPort } from './port.js'

// Real sockets and a real child process: the two launch steps that touch the
// operating system.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oth-launch-'))
  clearDbPathCache()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fakeOpencode(script: string): string {
  const file = join(dir, 'opencode')
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
  return file
}

describe('allocateLoopbackPort', () => {
  it('returns a port that is free to bind on loopback', async () => {
    const port = await allocateLoopbackPort()
    await new Promise<void>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => server.close(() => resolve()))
    })
  })
})

describe('resolveOpencodeDbPath', () => {
  it('asks the installed CLI and takes the last line as the path', async () => {
    const binary = fakeOpencode(`[ "$1" = db ] && [ "$2" = path ] || exit 3\necho "update available"\necho "$XDG_DATA_HOME/opencode/opencode.db"`)
    const path = await resolveOpencodeDbPath({ binary, env: { XDG_DATA_HOME: '/data', PATH: '/usr/bin:/bin' } })
    expect(path).toBe('/data/opencode/opencode.db')
  })

  it('memoises per binary and data location, and re-asks when the location moves', async () => {
    const counter = join(dir, 'calls')
    const binary = fakeOpencode(`echo x >> ${counter}\necho "$XDG_DATA_HOME/opencode.db"`)
    await resolveOpencodeDbPath({ binary, env: { XDG_DATA_HOME: '/a', PATH: '/usr/bin:/bin' } })
    await resolveOpencodeDbPath({ binary, env: { XDG_DATA_HOME: '/a', PATH: '/usr/bin:/bin', UNRELATED: '1' } })
    const moved = await resolveOpencodeDbPath({ binary, env: { XDG_DATA_HOME: '/b', PATH: '/usr/bin:/bin' } })
    expect(moved).toBe('/b/opencode.db')
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('rejects output that is not an absolute path, and does not cache the failure', async () => {
    const binary = fakeOpencode('echo "not a path"')
    await expect(resolveOpencodeDbPath({ binary, env: { PATH: '/usr/bin:/bin' } })).rejects.toThrow(/absolute path/)
    writeFileSync(binary, '#!/bin/sh\necho /fixed/opencode.db\n')
    await expect(resolveOpencodeDbPath({ binary, env: { PATH: '/usr/bin:/bin' } })).resolves.toBe('/fixed/opencode.db')
  })

  // #1114. The whole incident was diagnosed from the app's incident log rather
  // than from the error, because a child killed by execFile's timeout writes no
  // stderr and Node's message is then just `Command failed: <cmd>`. Each case
  // below is a distinct operator action — wait and retry, fix the install,
  // upgrade OpenCode — so the message has to tell them apart.
  it('names a timeout as a timeout, with the budget it blew', async () => {
    const binary = fakeOpencode('sleep 5')
    await expect(
      resolveOpencodeDbPath({ binary, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 60 }),
    ).rejects.toThrow(/timed out after 60 ms and was killed with SIGTERM/)
  })

  it('reports a non-zero exit with its code and what the binary complained about', async () => {
    const binary = fakeOpencode('echo "unknown command: db" >&2\nexit 2')
    await expect(
      resolveOpencodeDbPath({ binary, env: { PATH: '/usr/bin:/bin' } }),
    ).rejects.toThrow(/exited with code 2: unknown command: db/)
  })

  it('reports a binary that could not be started by its spawn code', async () => {
    await expect(
      resolveOpencodeDbPath({ binary: join(dir, 'absent'), env: { PATH: '/usr/bin:/bin' } }),
    ).rejects.toThrow(/could not be started \(ENOENT\)/)
  })
})

// The cache key must cover every input that decides WHICH executable answers
// and WHERE it keeps its data (review R2-F10). Each stub prints a path that
// only it would print, so the oracle is the stub's own identity.
describe('resolveOpencodeDbPath cache key', () => {
  function stubIn(subdir: string, script: string): string {
    const folder = join(dir, subdir)
    mkdirSync(folder, { recursive: true })
    const file = join(folder, 'opencode')
    writeFileSync(file, `#!/bin/sh\n${script}\n`)
    chmodSync(file, 0o755)
    return folder
  }

  it('lets PATH pick the executable for a bare binary name', async () => {
    const a = stubIn('a', 'echo /data/a/opencode.db')
    const b = stubIn('b', 'echo /data/b/opencode.db')
    expect(await resolveOpencodeDbPath({ binary: 'opencode', env: { PATH: a } })).toBe('/data/a/opencode.db')
    expect(await resolveOpencodeDbPath({ binary: 'opencode', env: { PATH: b } })).toBe('/data/b/opencode.db')
    // The same PATH again is served from the cache, not by another run.
    writeFileSync(join(a, 'opencode'), '#!/bin/sh\necho /data/replaced/opencode.db\n')
    expect(await resolveOpencodeDbPath({ binary: 'opencode', env: { PATH: a } })).toBe('/data/a/opencode.db')
  })

  it('resolves a relative binary against the cwd, so two cwds are two answers', async () => {
    const a = stubIn('cwd-a', 'echo /data/cwd-a/opencode.db')
    const b = stubIn('cwd-b', 'echo /data/cwd-b/opencode.db')
    expect(await resolveOpencodeDbPath({ binary: './opencode', env: { PATH: '/usr/bin:/bin' }, cwd: a })).toBe('/data/cwd-a/opencode.db')
    expect(await resolveOpencodeDbPath({ binary: './opencode', env: { PATH: '/usr/bin:/bin' }, cwd: b })).toBe('/data/cwd-b/opencode.db')
  })

  it('keeps one answer for an absolute binary across cwds and unrelated PATHs', async () => {
    const counter = join(dir, 'abs-calls')
    const folder = stubIn('abs', `echo x >> ${counter}\necho /data/abs/opencode.db`)
    const binary = join(folder, 'opencode')
    await resolveOpencodeDbPath({ binary, env: { PATH: '/usr/bin' }, cwd: '/tmp' })
    await resolveOpencodeDbPath({ binary, env: { PATH: '/bin' }, cwd: '/' })
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('re-asks when OPENCODE_DISABLE_CHANNEL_DB changes, which moves the database upstream', async () => {
    // storage/db.ts picks the channel-suffixed file unless this flag is set.
    const folder = stubIn('channel', 'if [ -n "$OPENCODE_DISABLE_CHANNEL_DB" ]; then echo /data/opencode.db; else echo /data/opencode-dev.db; fi')
    const binary = join(folder, 'opencode')
    expect(await resolveOpencodeDbPath({ binary, env: { PATH: '/usr/bin:/bin' } })).toBe('/data/opencode-dev.db')
    expect(await resolveOpencodeDbPath({ binary, env: { PATH: '/usr/bin:/bin', OPENCODE_DISABLE_CHANNEL_DB: '1' } })).toBe('/data/opencode.db')
  })
})
