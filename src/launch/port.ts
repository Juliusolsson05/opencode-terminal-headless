// Loopback port allocation for the TUI's server.
//
// WHY pre-allocate instead of `--port 0`: the TUI never prints the address it
// bound (it owns the terminal), so a random port would be undiscoverable. The
// OS hands out a free ephemeral port, we release it and pass it on the command
// line. The window between release and the TUI binding is tiny; if another
// process wins it, the TUI neither exits nor paints (Stage 0 port-conflict
// recording). The headless reports that as `live-state: server-unreachable`
// after its connect deadline instead of pretending the pane is healthy.

import { createServer } from 'node:net'

export async function allocateLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(error => (error ? reject(error) : port > 0 ? resolve(port) : reject(new Error('no port assigned'))))
    })
  })
}
