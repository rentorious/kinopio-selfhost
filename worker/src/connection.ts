import path from 'node:path'
import { WebSocket } from 'ws'
import type { JobOffer, ServerMessage, WorkerMessage } from '../../src/media/contract'
import { FEATURE_FILE_OFFSET } from '../../src/media/contract'
import type { WorkerConfig } from './config'
import { runJob } from './job'

export const VERSION = '0.2.1'

/**
 * The server pings every 15 s (src/media/worker-hub.ts). If nothing arrives for
 * three of those, the connection is dead even if no `close` came: Railway's
 * proxy can keep our side of the socket open after the server dropped it.
 */
export const SILENCE_MS = 45_000

/**
 * Keeps one websocket open to the server, reconnecting with backoff, and runs
 * at most one job at a time (docs/MEDIA-SUMMARIES.md §5).
 */
export class Worker {
  private ws?: WebSocket
  private stopped = false
  private backoffMs = 1000
  private reconnectTimer?: NodeJS.Timeout
  private silenceTimer?: NodeJS.Timeout
  private active?: { jobId: string, controller: AbortController, done: Promise<void> }

  constructor (
    private readonly config: WorkerConfig,
    private readonly log: (msg: string) => void = msg => console.log(`[worker] ${msg}`),
    private readonly silenceMs = SILENCE_MS
  ) {}

  start (): void {
    this.stopped = false
    this.connect()
  }

  async stop (): Promise<void> {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.silenceTimer)
    this.active?.controller.abort()
    await this.active?.done
    this.ws?.close()
  }

  get busyWith (): string | undefined { return this.active?.jobId }

  private connect (): void {
    const url = this.config.serverUrl.replace(/^http/, 'ws') + '/api/worker/ws'
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.config.token}` } })
    this.ws = ws
    const heard = (): void => {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = setTimeout(() => {
        if (this.ws !== ws) return
        this.log(`no word from the server for ${Math.round(this.silenceMs / 1000)} s; reconnecting`)
        ws.terminate()
      }, this.silenceMs)
    }
    ws.on('ping', heard)
    ws.on('open', () => {
      heard()
      this.backoffMs = 1000
      this.log(`connected to ${this.config.serverUrl}`)
      this.send({
        type: 'hello',
        version: VERSION,
        model: path.basename(this.config.whisperModel).replace(/^ggml-|\.bin$/g, ''),
        gpu: this.config.gpuName,
        features: [FEATURE_FILE_OFFSET],
        ...(this.active ? { activeJobId: this.active.jobId } : {})
      })
    })
    ws.on('message', raw => {
      heard()
      let msg: ServerMessage
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type === 'job') this.onJob(msg.job)
      if (msg.type === 'cancel' && this.active?.jobId === msg.jobId) {
        this.log(`job ${msg.jobId} canceled by the server`)
        this.active.controller.abort()
      }
    })
    ws.on('unexpected-response', (_req, res) => {
      this.log(`server refused the connection (${res.statusCode})${res.statusCode === 401 ? ': check WORKER_TOKEN' : ''}`)
    })
    ws.on('error', err => this.log(`connection error: ${err.message}`))
    ws.on('close', () => {
      if (this.ws !== ws) return
      this.ws = undefined
      clearTimeout(this.silenceTimer)
      if (this.stopped) return
      this.log(`disconnected; retrying in ${Math.round(this.backoffMs / 1000)} s`)
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
    })
  }

  private send (msg: WorkerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private onJob (offer: JobOffer): void {
    if (this.active) {
      if (this.active.jobId !== offer.jobId) this.send({ type: 'failed', jobId: offer.jobId, reason: 'the transcriber is busy' })
      return
    }
    this.log(`job ${offer.jobId}: ${offer.fileName}, ${Math.round((offer.endMs - offer.startMs) / 1000)} s, language ${offer.language}`)
    const controller = new AbortController()
    const done = runJob(offer, {
      config: this.config,
      send: msg => this.send(msg),
      log: msg => this.log(`job ${offer.jobId}: ${msg}`),
      signal: controller.signal
    }).finally(() => { if (this.active?.jobId === offer.jobId) this.active = undefined })
    this.active = { jobId: offer.jobId, controller, done }
  }
}
