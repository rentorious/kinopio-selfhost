import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { WebSocket, WebSocketServer, RawData } from 'ws'
import { isValidId } from '../common/ids'
import { DB, Db } from '../db/database'
import { changesContent, isAllowedAction, RELAYED_NAMES } from './allowlist'

type Json = Record<string, unknown>

interface Peer {
  socket: WebSocket
  alive: boolean
  /** Space id of the room this socket joined; identity below is bound at join time. */
  room?: string
  userId?: string
  user?: Json
  readOnly: boolean
  /** Messages are handled one at a time, so a join's DB lookups finish before the next message. */
  queue: Promise<void>
}

const SECRET_KEYS = ['apiKey', 'email', 'arenaAccessToken']
const PING_MS = 30_000

/** Remove keys that must never reach another client, up to a few levels down. */
export function stripSecrets (value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(v => stripSecrets(v, depth + 1))
  const out: Json = {}
  for (const [k, v] of Object.entries(value)) {
    if (!SECRET_KEYS.includes(k)) out[k] = stripSecrets(v, depth + 1)
  }
  return out
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * The realtime relay (docs/WEBSOCKET.md): rooms per space, auth at join time,
 * and only allowlisted store actions are forwarded. It never persists
 * anything; saving goes through POST /operations.
 */
@Injectable()
export class Relay implements OnModuleDestroy {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  private readonly log = new Logger('Relay')
  private readonly rooms = new Map<string, Set<Peer>>()
  private readonly peers = new Set<Peer>()
  private readonly interval: NodeJS.Timeout

  constructor (@Inject(DB) private readonly db: Db) {
    this.wss.on('connection', socket => this.onConnection(socket))
    // Ping so Railway's proxy doesn't drop idle sockets (the client never sends
    // a heartbeat), and drop sockets that stopped answering.
    this.interval = setInterval(() => this.heartbeat(), PING_MS)
    this.interval.unref()
  }

  onModuleDestroy (): void {
    clearInterval(this.interval)
    for (const socket of this.wss.clients) socket.terminate()
    this.wss.close()
  }

  /** Send a server-originated message to everyone viewing a space. Returns how many sockets got it. */
  broadcast (spaceId: string, payload: { message: Json } & Json): number {
    return this.sendToRoom(spaceId, { ...payload, spaceId })
  }

  /** Number of sockets currently in a space's room (for tests and status). */
  roomSize (spaceId: string): number {
    return this.rooms.get(spaceId)?.size ?? 0
  }

  private onConnection (socket: WebSocket): void {
    const peer: Peer = { socket, alive: true, readOnly: true, queue: Promise.resolve() }
    this.peers.add(peer)
    socket.on('pong', () => { peer.alive = true })
    socket.on('message', raw => {
      peer.queue = peer.queue
        .then(() => this.onMessage(peer, raw))
        .catch(err => this.log.error(err instanceof Error ? err.stack : String(err)))
    })
    socket.on('close', () => {
      this.peers.delete(peer)
      peer.queue = peer.queue.then(() => this.leave(peer))
    })
    socket.on('error', () => socket.terminate())
    this.send(peer, { message: { name: 'connected' } })
  }

  private heartbeat (): void {
    for (const peer of this.peers) {
      if (!peer.alive) { peer.socket.terminate(); continue }
      peer.alive = false
      peer.socket.ping()
    }
  }

  private async onMessage (peer: Peer, raw: RawData): Promise<void> {
    let data: unknown
    try { data = JSON.parse(raw.toString()) } catch { return }
    if (!isObject(data) || !isObject(data.message)) return
    const message = data.message
    const name = str(message.name)
    const action = str(message.action)

    if (name === 'joinSpaceRoom') return await this.join(peer, data)
    if (name === 'userLeftRoom') {
      if (!data.spaceId || data.spaceId === peer.room) this.leave(peer)
      return
    }
    // everything else needs a joined socket and must be about its room
    if (!peer.room || data.spaceId !== peer.room) return

    if (action) {
      const store = str(message.store) ?? 'globalStore'
      if (!isAllowedAction(store, action)) {
        this.log.warn(`dropped ${store}.${action} from ${peer.userId ?? 'anonymous'}`)
        return
      }
      if (peer.readOnly && changesContent(store, action)) return
    } else if (!name || !RELAYED_NAMES.has(name)) {
      return
    }
    const out: Json = { ...data, message: { ...message, updates: stripSecrets(message.updates) } }
    if (out.user !== undefined) out.user = stripSecrets(out.user)
    delete out.credentials
    this.sendToRoom(peer.room, out, peer)
  }

  private async join (peer: Peer, data: Json): Promise<void> {
    const spaceId = data.spaceId
    if (!isValidId(spaceId)) return
    const credentials = isObject(data.credentials) ? data.credentials : {}
    const apiKey = str(credentials.apiKey)
    const collaboratorKey = isObject(credentials.collaboratorKey)
      ? str(credentials.collaboratorKey.collaboratorKey)
      : str(credentials.collaboratorKey)
    const readOnlyKey = str(credentials.readOnlyKey)

    const space = await this.db.selectFrom('spaces')
      .select(['owner_id', 'privacy', 'collaborator_key', 'read_only_key'])
      .where('id', '=', spaceId)
      .executeTakeFirst()
    if (!space) {
      // A brand-new space joins before its createSpace op lands, then re-joins.
      // An error now would leave a sticky banner, so stay quiet.
      this.leave(peer)
      return
    }
    const userId = apiKey
      ? (await this.db.selectFrom('users').select('id').where('api_key', '=', apiKey).executeTakeFirst())?.id
      : undefined
    const isOwner = !!userId && userId === space.owner_id
    const hasCollaboratorKey = !!collaboratorKey && collaboratorKey === space.collaborator_key
    const hasReadOnlyKey = !!readOnlyKey && readOnlyKey === space.read_only_key
    const isPublic = space.privacy === 'open' || space.privacy === 'closed'
    if (!isOwner && !hasCollaboratorKey && !hasReadOnlyKey && !isPublic) {
      this.leave(peer)
      this.send(peer, { message: { name: 'joinSpaceRoomError' } })
      return
    }

    const isRejoin = peer.room === spaceId
    if (!isRejoin) this.leave(peer)
    peer.room = spaceId
    peer.userId = userId
    peer.user = isObject(data.user) ? stripSecrets(data.user) as Json : undefined
    peer.readOnly = !(isOwner || hasCollaboratorKey || space.privacy === 'open')
    if (!this.rooms.has(spaceId)) this.rooms.set(spaceId, new Set())
    this.rooms.get(spaceId)!.add(peer)
    if (!isRejoin) {
      this.sendToRoom(spaceId, { message: { name: 'userJoinedRoom' }, user: peer.user ?? {}, spaceId }, peer)
    }
  }

  private leave (peer: Peer): void {
    const room = peer.room
    if (!room) return
    const members = this.rooms.get(room)
    members?.delete(peer)
    if (members && members.size === 0) this.rooms.delete(room)
    peer.room = undefined
    this.sendToRoom(room, { message: { name: 'userLeftRoom' }, user: { id: peer.user?.id }, spaceId: room })
  }

  private sendToRoom (spaceId: string, payload: Json, except?: Peer): number {
    const members = this.rooms.get(spaceId)
    if (!members) return 0
    const text = JSON.stringify(payload)
    let sent = 0
    for (const peer of members) {
      if (peer === except || peer.socket.readyState !== WebSocket.OPEN) continue
      peer.socket.send(text)
      sent++
    }
    return sent
  }

  private send (peer: Peer, payload: Json): void {
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(payload))
  }
}
