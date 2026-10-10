import type { Server } from 'node:http'
import { WebSocketServer } from 'ws'

/**
 * Placeholder for the realtime relay (M2, docs/WEBSOCKET.md).
 *
 * The client opens a socket on every space page and reconnects with backoff
 * whenever the upgrade fails, so until the relay exists we accept the
 * connection and quietly ignore everything. Nothing is relayed: edits from
 * another device show up on reload or on the client's staleness check.
 */
export function attachSocket (server: Server, path = '/api/ws'): WebSocketServer {
  const wss = new WebSocketServer({ server, path, maxPayload: 1024 * 1024 })
  wss.on('connection', socket => {
    socket.on('message', () => { /* M2: relay to the room */ })
    socket.on('error', () => socket.terminate())
  })
  // keep idle connections alive through Railway's proxy
  const interval = setInterval(() => {
    for (const client of wss.clients) client.ping()
  }, 30_000)
  wss.on('close', () => clearInterval(interval))
  server.on('close', () => wss.close())
  return wss
}
