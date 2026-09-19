import { createServer, type IncomingMessage } from 'node:http'
import { afterEach, expect, it } from 'vitest'

import { LiveServerClient } from './LiveServerClient.js'

// The request Agent Code #843 depends on, against a real HTTP server on
// loopback: the TUI's own server route, its credentials and the one command.
// The live TUI answers this route 200 for ANY command, and `session.last` was
// probed to do nothing while `messages_last` scrolls (see LiveServerClient),
// so the exact command string is what this pins.
const servers: Array<{ close(): void }> = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })

it('asks the TUI server to run messages_last, with the server credentials and the instance directory', async () => {
  const seen: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body })
      response.writeHead(200, { 'content-type': 'application/json' }).end('true')
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const client = new LiveServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, username: 'opencode', password: 'secret', directory: '/work/project' })

  await client.jumpToLatest()

  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ method: 'POST', url: '/tui/execute-command', body: JSON.stringify({ command: 'messages_last' }) })
  expect(seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from('opencode:secret').toString('base64')}`)
  expect(seen[0]!.headers['x-opencode-directory']).toBe(encodeURIComponent('/work/project'))
})

it('reports a refused request instead of pretending the jump happened', async () => {
  const server = createServer((_request, response) => { response.writeHead(401).end() })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const client = new LiveServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, username: 'opencode', password: 'wrong', directory: '/work' })
  await expect(client.jumpToLatest()).rejects.toThrow(/401/)
})
