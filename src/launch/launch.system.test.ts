import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
})
