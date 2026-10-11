import type { Server } from 'node:http'
import type { WebSocketServer } from 'ws'

/**
 * Route websocket upgrades by path. Each WebSocketServer runs with
 * `noServer: true`: two `ws` servers attached to the same HTTP server with
 * different `path`s would abort each other's handshakes.
 */
export function routeUpgrades (server: Server, routes: Record<string, WebSocketServer>): void {
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/(.)\/$/, '$1')
    const wss = routes[pathname]
    if (!wss) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })
}
