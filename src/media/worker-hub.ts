import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { EventEmitter } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { Config, CONFIG } from '../config'
import type { ServerMessage, WorkerMessage } from './contract'

const PING_MS = 15_000

/** Compare secrets in constant time, whatever their lengths. */
export function sameSecret (given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export function bearer (header: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '')
  return m?.[1]
}

export interface WorkerInfo {
  version: string
  model: string
  gpu: string
}

/**
 * The connection to the transcription worker on the home PC
 * (docs/MEDIA-SUMMARIES.md §5). The worker dials out to /api/worker/ws with
 * `Authorization: Bearer <WORKER_TOKEN>`; one worker at a time, a new
 * connection replaces the old one. Events: 'message' (WorkerMessage),
 * 'connected', 'disconnected'.
 */
@Injectable()
export class WorkerHub extends EventEmitter implements OnModuleDestroy {
  readonly wss: WebSocketServer
  private readonly log = new Logger('Worker')
  private socket?: WebSocket
  private alive = false
  private info?: WorkerInfo
  private seenAt?: Date
  private readonly interval: NodeJS.Timeout

  constructor (@Inject(CONFIG) private readonly config: Config) {
    super()
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 256 * 1024,
      verifyClient: (info: { req: IncomingMessage }) => sameSecret(bearer(info.req.headers.authorization), config.media.workerToken)
    })
    this.wss.on('connection', socket => this.onConnection(socket))
    this.interval = setInterval(() => this.heartbeat(), PING_MS)
    this.interval.unref()
  }

  onModuleDestroy (): void {
    clearInterval(this.interval)
    this.socket?.terminate()
    this.wss.close()
  }

  /**
   * Connected and said hello. Until the hello arrives the server can't tell a
   * reconnect that kept its job from one that lost it, so no job is offered.
   * A worker that stops answering pings is dropped within two ping intervals.
   */
  get online (): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN && !!this.info
  }

  get lastSeenAt (): Date | undefined { return this.seenAt }
  get workerInfo (): WorkerInfo | undefined { return this.info }

  send (message: ServerMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  private onConnection (socket: WebSocket): void {
    if (this.socket && this.socket !== socket) {
      this.log.log('a new worker connection replaces the old one')
      const old = this.socket
      this.socket = undefined
      old.terminate()
    }
    this.socket = socket
    this.info = undefined
    this.alive = true
    this.seenAt = new Date()
    socket.on('pong', () => { this.alive = true; this.seenAt = new Date() })
    socket.on('message', raw => {
      this.seenAt = new Date()
      let msg: WorkerMessage
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return
      if (msg.type === 'hello') {
        this.info = { version: String(msg.version ?? ''), model: String(msg.model ?? ''), gpu: String(msg.gpu ?? '') }
        this.log.log(`worker connected: ${this.info.model} on ${this.info.gpu} (v${this.info.version})`)
      }
      this.emit('message', msg)
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.alive = false
      this.log.warn('worker disconnected')
      this.emit('disconnected')
    })
    socket.on('error', () => socket.terminate())
    this.emit('connected')
  }

  private heartbeat (): void {
    const socket = this.socket
    if (!socket) return
    if (!this.alive) { socket.terminate(); return }
    this.alive = false
    socket.ping()
  }
}
