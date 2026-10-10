import { clientFixture, setup, TestContext } from './helpers'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('spaces', () => {
  let t: TestContext
  let me: { id: string, apiKey: string }
  let other: { id: string, apiKey: string }
  const auth = (u: { apiKey: string }) => ({ Authorization: u.apiKey })

  beforeEach(async () => {
    t = await setup()
    const a = await t.users.createUser({ email: 'me@x.com', password: 'pw', withInbox: true })
    const b = await t.users.createUser({ email: 'other@x.com', password: 'pw', withInbox: true })
    me = { id: String(a.id), apiKey: String(a.apiKey) }
    other = { id: String(b.id), apiKey: String(b.apiKey) }
  })
  afterEach(async () => { await t.close() })

  /** What the client posts after sign-in: cached spaces, rewritten to the new user. */
  function asLocalSpace (fixture: Json, userId: string): Json {
    const space = JSON.parse(JSON.stringify(fixture))
    space.userId = userId
    space.users = [{ id: userId, apiKey: 'MUST-NOT-BE-STORED', email: 'leak@x.com' }]
    space.cacheDate = Date.now()
    return space
  }

  it('round-trips the client\'s own Hello space through POST /space/multiple and GET /space/:id', async () => {
    const hello = asLocalSpace(clientFixture('hello.json'), me.id)
    await t.http().post('/api/space/multiple').set(auth(me)).send([hello]).expect(200)
    const res = await t.http().get(`/api/space/${hello.id}`).set(auth(me)).expect(200)
    const space: Json = res.body

    expect(space.id).toBe(hello.id)
    expect(space.name).toBe('Hello Kinopio')
    expect(space.userId).toBe(me.id)
    for (const key of ['cards', 'connections', 'boxes', 'lists', 'lines', 'tags', 'drawingStrokes', 'users', 'collaborators', 'groups', 'clients', 'spectators']) {
      expect(Array.isArray(space[key])).toBe(true)
    }
    expect(space.cards).toHaveLength(hello.cards.length)
    expect(space.connections).toHaveLength(hello.connections.length)
    expect(space.lines).toHaveLength(hello.lines.length)
    expect(space.lists).toHaveLength(hello.lists.length)

    // every field of every card survives, except the ones we own (dates, spaceId, userId)
    const byId = new Map(space.cards.map((c: Json) => [c.id, c]))
    for (const card of hello.cards) {
      const back = byId.get(card.id) as Json
      for (const [k, v] of Object.entries(card)) {
        if (['createdAt', 'updatedAt', 'spaceId', 'userId'].includes(k)) continue
        expect([k, back[k]]).toEqual([k, v])
      }
      expect(back.spaceId).toBe(hello.id)
    }

    // strokes come back as raw point arrays in the same (newest first) order
    expect(space.drawingStrokes).toEqual(hello.drawingStrokes)

    // space meta survives; users never comes from the body
    expect(space.background).toBe(hello.background)
    expect(space.users).toEqual([expect.objectContaining({ id: me.id, isUpgraded: true })])
    expect(JSON.stringify(space)).not.toContain('MUST-NOT-BE-STORED')
    expect(space.collaboratorKey).toEqual(expect.any(String))
    expect(space.url).toBe(`hello-kinopio-${hello.id}`)
  })

  it('never overwrites an existing space from a (possibly stale) snapshot', async () => {
    const inbox = asLocalSpace(clientFixture('inbox.json'), me.id)
    inbox.id = 'myInboxSpaceId1'
    await t.http().post('/api/space').set(auth(me)).send(inbox).expect(200)
    const stale = { ...inbox, name: 'Stale name', cards: [] }
    const res = await t.http().post('/api/space').set(auth(me)).send(stale).expect(200)
    expect(res.body.result).toBe('exists')
    const back = await t.http().get('/api/space/myInboxSpaceId1').set(auth(me)).expect(200)
    expect(back.body.name).toBe('Inbox')
    expect(back.body.cards).toHaveLength(2)
    // and nobody else can take it over
    await t.http().post('/api/space').set(auth(other)).send(stale).expect(401)
  })

  it('keeps locally removed spaces removed when they arrive with sign-in', async () => {
    const removed = { ...asLocalSpace(clientFixture('inbox.json'), me.id), id: 'removedLocally1', name: 'Old', isRemoved: true, removedByUserId: me.id }
    await t.http().post('/api/space/multiple').set(auth(me)).send([removed]).expect(200)
    const list = await t.http().get('/api/user/spaces').set(auth(me)).expect(200)
    expect(list.body.map((s: Json) => s.id)).not.toContain('removedLocally1')
    const removedList = await t.http().get('/api/user/removed-spaces').set(auth(me)).expect(200)
    expect(removedList.body.map((s: Json) => s.id)).toContain('removedLocally1')
    const restored = await t.http().patch('/api/space/restore/removedLocally1').set(auth(me)).expect(200)
    expect(Array.isArray(restored.body.cards)).toBe(true)
    expect(restored.body.isRemoved).toBe(false)
  })

  it('lists the user\'s spaces as summaries, newest first', async () => {
    const hello = asLocalSpace(clientFixture('hello.json'), me.id)
    await t.http().post('/api/space/multiple').set(auth(me)).send([hello]).expect(200)
    const res = await t.http().get('/api/user/spaces').set(auth(me)).expect(200)
    const ids = res.body.map((s: Json) => s.id)
    expect(ids).toContain(hello.id)
    const summary = res.body.find((s: Json) => s.id === hello.id)
    expect(summary).toMatchObject({ name: 'Hello Kinopio', privacy: 'private', userId: me.id, url: expect.any(String) })
    expect(summary.cards).toBeUndefined()
    // other users' spaces aren't listed
    const theirs = await t.http().get('/api/user/spaces').set(auth(other)).expect(200)
    expect(theirs.body.map((s: Json) => s.id)).not.toContain(hello.id)
  })

  it('applies read permissions: 401 private, 404 unknown, keys and public spaces readable', async () => {
    const hello = asLocalSpace(clientFixture('hello.json'), me.id)
    await t.http().post('/api/space').set(auth(me)).send(hello).expect(200)
    await t.http().get('/api/space/doesNotExist123').set(auth(me)).expect(404)
    const denied = await t.http().get(`/api/space/${hello.id}`).set(auth(other)).expect(401)
    expect(denied.body).toMatchObject({ status: 401 })
    await t.http().get(`/api/space/${hello.id}`).expect(401)

    const mine = await t.http().get(`/api/space/${hello.id}`).set(auth(me)).expect(200)
    const viaKey = await t.http().get(`/api/space/${hello.id}`).set('Space-Authorization', mine.body.collaboratorKey).expect(200)
    expect(viaKey.body.collaboratorKey).toBe(mine.body.collaboratorKey)
    expect(viaKey.body.readOnlyKey).toBeNull()
    const viaReadOnly = await t.http().get(`/api/space/${hello.id}`).set('Read-Only-Authorization', mine.body.readOnlyKey).expect(200)
    expect(viaReadOnly.body.collaboratorKey).toBeNull()

    await t.http().patch('/api/space').set(auth(me)).send({ id: hello.id, privacy: 'closed' }).expect(200)
    await t.http().get(`/api/space/${hello.id}`).expect(200)
    // public, but still not editable by others
    await t.http().patch('/api/space').set(auth(other)).send({ id: hello.id, name: 'mine now' }).expect(401)
  })

  it('answers updated-at with nulls instead of errors for unknown spaces', async () => {
    const res = await t.http().get('/api/space/updated-at/nope123').set(auth(me)).expect(200)
    expect(res.body).toEqual({ id: 'nope123', editedAt: null, updatedAt: null })
    const inbox = await t.http().get('/api/space/inbox').set(auth(me)).expect(200)
    const known = await t.http().get(`/api/space/updated-at/${inbox.body.id}`).set(auth(me)).expect(200)
    expect(known.body.updatedAt).toEqual(expect.any(String))
  })

  it('serves removed cards', async () => {
    const hello = asLocalSpace(clientFixture('hello.json'), me.id)
    hello.removedCards = [{ ...hello.cards[0], id: 'removedCard001', name: 'gone' }]
    await t.http().post('/api/space').set(auth(me)).send(hello).expect(200)
    const res = await t.http().get(`/api/space/${hello.id}/removed-cards`).set(auth(me)).expect(200)
    expect(res.body).toEqual([expect.objectContaining({ id: 'removedCard001', isRemoved: true, name: 'gone' })])
    await t.http().get(`/api/space/${hello.id}/removed-cards`).set(auth(other)).expect(401)
  })
})
