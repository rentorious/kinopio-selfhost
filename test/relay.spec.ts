import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { Relay } from '../src/realtime/relay'
import { setup, TestContext } from './helpers'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** A websocket client that records every message, like a browser tab. */
class Tab {
  private messages: Json[] = []
  private waiters: Array<{ match: (m: Json) => boolean, resolve: (m: Json) => void }> = []

  private constructor (readonly ws: WebSocket, readonly clientId: string) {
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString())
      const waiter = this.waiters.find(w => w.match(msg))
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(msg)
      } else {
        this.messages.push(msg)
      }
    })
  }

  static async open (url: string, clientId: string): Promise<Tab> {
    const ws = new WebSocket(url)
    // listen before 'open': the server's first message can arrive in the same tick
    const tab = new Tab(ws, clientId)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    await tab.next(m => m.message?.name === 'connected')
    return tab
  }

  send (data: Json): void {
    this.ws.send(JSON.stringify({ clientId: this.clientId, ...data }))
  }

  join (spaceId: string, credentials: Json, user: Json = { id: this.clientId }): void {
    this.send({ message: { name: 'joinSpaceRoom' }, spaceId, user, credentials })
  }

  action (spaceId: string, store: string | undefined, action: string, updates: unknown): void {
    this.send({ message: { action, ...(store ? { store } : {}), updates }, spaceId, user: { id: this.clientId } })
  }

  next (match: (m: Json) => boolean, timeoutMs = 2000): Promise<Json> {
    const i = this.messages.findIndex(match)
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve }
      this.waiters.push(waiter)
      setTimeout(() => {
        const at = this.waiters.indexOf(waiter)
        if (at >= 0) { this.waiters.splice(at, 1); reject(new Error('timed out waiting for a message')) }
      }, timeoutMs).unref()
    })
  }

  /** Wait a moment, then return everything received that matches. */
  async received (match: (m: Json) => boolean = () => true, waitMs = 200): Promise<Json[]> {
    await new Promise(resolve => setTimeout(resolve, waitMs))
    return this.messages.filter(match)
  }

  close (): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise(resolve => { this.ws.once('close', () => resolve()); this.ws.close() })
  }
}

const isAction = (action: string) => (m: Json) => m.message?.action === action

describe('websocket relay', () => {
  let t: TestContext
  let url: string
  let me: { id: string, apiKey: string }
  let other: { id: string, apiKey: string }
  let tabs: Tab[]
  const spaceId = 'relaySpace1234567890a'

  async function tab (): Promise<Tab> {
    const created = await Tab.open(url, `client-${tabs.length}`)
    tabs.push(created)
    return created
  }

  /** Two tabs of the owner in the same space, both joined. */
  async function ownerPair (): Promise<[Tab, Tab]> {
    const a = await tab()
    const b = await tab()
    a.join(spaceId, { apiKey: me.apiKey })
    await waitForRoom(1)
    b.join(spaceId, { apiKey: me.apiKey })
    await a.next(m => m.message?.name === 'userJoinedRoom')
    return [a, b]
  }

  async function waitForRoom (size: number, id = spaceId): Promise<void> {
    const relay = t.app.get(Relay)
    for (let i = 0; i < 50 && relay.roomSize(id) !== size; i++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(relay.roomSize(id)).toBe(size)
  }

  beforeEach(async () => {
    t = await setup()
    await t.app.listen(0, '127.0.0.1')
    const port = (t.app.getHttpServer().address() as AddressInfo).port
    url = `ws://127.0.0.1:${port}/api/ws`
    const a = await t.users.createUser({ email: 'me@x.com', password: 'pw', withInbox: true })
    const b = await t.users.createUser({ email: 'other@x.com', password: 'pw', withInbox: true })
    me = { id: String(a.id), apiKey: String(a.apiKey) }
    other = { id: String(b.id), apiKey: String(b.apiKey) }
    await t.http().post('/api/space').set({ Authorization: me.apiKey }).send({ id: spaceId, name: 'Relay', privacy: 'private' }).expect(200)
    tabs = []
  })
  afterEach(async () => {
    await Promise.all(tabs.map(x => x.close().catch(() => undefined)))
    await t.close()
  })

  it('relays an allowed action to the other tab only, unchanged', async () => {
    const [a, b] = await ownerPair()
    b.action(spaceId, 'cardStore', 'updateCardsState', [{ id: 'card1', x: 40 }])
    const got = await a.next(isAction('updateCardsState'))
    expect(got).toMatchObject({ clientId: 'client-1', spaceId, message: { store: 'cardStore', updates: [{ id: 'card1', x: 40 }] } })
    expect(await b.received(isAction('updateCardsState'))).toHaveLength(0)
  })

  it('relays globalStore actions sent without a store (cursors)', async () => {
    const [a, b] = await ownerPair()
    b.action(spaceId, undefined, 'triggerUpdateRemoteUserCursor', { x: 1, y: 2 })
    await a.next(isAction('triggerUpdateRemoteUserCursor'))
  })

  it('drops actions that are not on the allowlist', async () => {
    const [a, b] = await ownerPair()
    b.action(spaceId, 'userStore', 'updateUser', { name: 'pwned' })
    b.action(spaceId, 'globalStore', 'updateCurrentUser', {})
    b.action(spaceId, 'cardStore', 'deleteAllCards', {})
    expect(await a.received(m => !!m.message?.action)).toHaveLength(0)
  })

  it('strips apiKey, email and arenaAccessToken from relayed updates and users', async () => {
    const [a, b] = await ownerPair()
    b.send({
      message: { action: 'updateUser', store: 'spaceStore', updates: { id: me.id, name: 'Me', apiKey: 'secret', email: 'me@x.com', arenaAccessToken: 't' } },
      spaceId,
      user: { id: me.id, apiKey: 'secret' }
    })
    const got = await a.next(isAction('updateUser'))
    expect(got.message.updates).toEqual({ id: me.id, name: 'Me' })
    expect(got.user).toEqual({ id: me.id })
  })

  it('drops messages for a space other than the joined room, and from sockets that never joined', async () => {
    const [a, b] = await ownerPair()
    const stranger = await tab()
    b.action('someOtherSpace123456', 'cardStore', 'updateCardsState', [{ id: 'x' }])
    stranger.action(spaceId, 'cardStore', 'updateCardsState', [{ id: 'y' }])
    expect(await a.received(m => !!m.message?.action)).toHaveLength(0)
  })

  it('refuses a private space to someone else with joinSpaceRoomError', async () => {
    const intruder = await tab()
    intruder.join(spaceId, { apiKey: other.apiKey })
    await intruder.next(m => m.message?.name === 'joinSpaceRoomError')
    await waitForRoom(0)
  })

  it('stays silent when the space does not exist yet, and joins once it does', async () => {
    const a = await tab()
    const newId = 'brandNewSpace12345678'
    a.join(newId, { apiKey: me.apiKey })
    expect(await a.received()).toHaveLength(0)
    await t.http().post('/api/space').set({ Authorization: me.apiKey }).send({ id: newId, name: 'New' }).expect(200)
    a.join(newId, { apiKey: me.apiKey })
    await waitForRoom(1, newId)
  })

  it('treats a readOnlyKey join as read-only: presence passes, edits do not', async () => {
    const [a] = await ownerPair()
    const { readOnlyKey } = (await t.http().get(`/api/space/${spaceId}`).set({ Authorization: me.apiKey }).expect(200)).body
    const viewer = await tab()
    viewer.join(spaceId, { apiKey: '', readOnlyKey })
    await a.next(m => m.message?.name === 'userJoinedRoom')
    viewer.action(spaceId, 'cardStore', 'updateCardsState', [{ id: 'card1', name: 'vandal' }])
    viewer.action(spaceId, 'globalStore', 'triggerAddDrawingStroke', { id: 's' })
    viewer.action(spaceId, undefined, 'triggerUpdateRemoteUserCursor', { x: 5 })
    await a.next(isAction('triggerUpdateRemoteUserCursor'))
    expect(await a.received(m => m.message?.action === 'updateCardsState' || m.message?.action === 'triggerAddDrawingStroke')).toHaveLength(0)
  })

  it('accepts collaboratorKey as a string or as {collaboratorKey}', async () => {
    const { collaboratorKey } = (await t.http().get(`/api/space/${spaceId}`).set({ Authorization: me.apiKey }).expect(200)).body
    const a = await tab()
    const b = await tab()
    a.join(spaceId, { apiKey: '', collaboratorKey })
    b.join(spaceId, { apiKey: '', collaboratorKey: { collaboratorKey } })
    await waitForRoom(2)
    b.action(spaceId, 'cardStore', 'updateCardsState', [{ id: 'c' }])
    await a.next(isAction('updateCardsState'))
  })

  it('tells the room when a tab leaves or switches spaces', async () => {
    const [a, b] = await ownerPair()
    b.send({ message: { name: 'userLeftRoom' }, spaceId, user: { id: 'client-1' } })
    expect(await a.next(m => m.message?.name === 'userLeftRoom')).toMatchObject({ user: { id: 'client-1' } })
    await waitForRoom(1)
    b.join(spaceId, { apiKey: me.apiKey })
    await a.next(m => m.message?.name === 'userJoinedRoom')
    await b.close()
    await a.next(m => m.message?.name === 'userLeftRoom')
    await waitForRoom(1)
  })

  it('re-joining the same room does not announce the tab twice', async () => {
    const [a, b] = await ownerPair()
    b.join(spaceId, { apiKey: me.apiKey })
    expect(await a.received(m => m.message?.name === 'userJoinedRoom')).toHaveLength(0)
    await waitForRoom(2)
  })

  it('lets the server broadcast to a room without a clientId', async () => {
    const [a, b] = await ownerPair()
    const sent = t.app.get(Relay).broadcast(spaceId, { message: { action: 'updateCardsState', store: 'cardStore', updates: [{ id: 'card1', name: 'from server' }] } })
    expect(sent).toBe(2)
    for (const x of [a, b]) {
      const got = await x.next(isAction('updateCardsState'))
      expect(got.clientId).toBeUndefined()
      expect(got.spaceId).toBe(spaceId)
    }
  })

  it('answers other websocket paths with 404', async () => {
    const ws = new WebSocket(url.replace('/api/ws', '/api/nope'))
    const err = await new Promise<Error>(resolve => ws.once('error', resolve))
    expect(err.message).toMatch(/404/)
  })
})
