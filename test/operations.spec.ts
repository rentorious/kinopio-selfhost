import { op, setup, TestContext } from './helpers'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('POST /operations', () => {
  let t: TestContext
  let me: { id: string, apiKey: string }
  let other: { id: string, apiKey: string }
  const spaceId = 'opsSpace0000001'
  let ctx: { spaceId: string, userId: string }

  const send = (ops: unknown[], user = me) => t.http().post('/api/operations').set('Authorization', user.apiKey).send(ops)
  const getSpace = async (id = spaceId): Promise<Json> => (await t.http().get(`/api/space/${id}`).set('Authorization', me.apiKey).expect(200)).body
  const card = (id: string, extra: Json = {}) => ({ id, x: 100, y: 100, z: 1, name: `card ${id}`, width: 80, height: 40, backgroundColor: '#fff', isRemoved: false, frameId: 0, ...extra })

  beforeEach(async () => {
    t = await setup()
    const a = await t.users.createUser({ email: 'me@x.com', password: 'pw', withInbox: true })
    const b = await t.users.createUser({ email: 'other@x.com', password: 'pw', withInbox: true })
    me = { id: String(a.id), apiKey: String(a.apiKey) }
    other = { id: String(b.id), apiKey: String(b.apiKey) }
    ctx = { spaceId, userId: me.id }
    // A brand new space arrives as createSpace followed by item ops, all in one batch.
    await send([
      op('createSpace', { id: spaceId, name: 'Ops', privacy: 'private', collaboratorKey: 'ck1', readOnlyKey: 'rk1', cards: [], connections: [], boxes: [], lists: [], lines: [], tags: [], drawingStrokes: [], removedCards: [], users: [{ id: me.id, apiKey: 'leak' }] }, ctx),
      op('createCard', card('cardA0000000001'), ctx)
    ]).expect(200)
  })
  afterEach(async () => { await t.close() })

  it('creates a space and its first card in one batch', async () => {
    const space = await getSpace()
    expect(space.name).toBe('Ops')
    expect(space.cards.map((c: Json) => c.id)).toEqual(['cardA0000000001'])
    expect(space.cards[0]).toMatchObject({ name: 'card cardA0000000001', userId: me.id })
    expect(space.cards[0].operationId).toBeUndefined()
    expect(space.cards[0].clientCreatedAt).toBeUndefined()
  })

  it('applies partial updates, where null clears a field', async () => {
    await send([
      op('updateCard', { id: 'cardA0000000001', x: 300 }, ctx),
      op('updateCard', { id: 'cardA0000000001', backgroundColor: null, isTodo: true }, ctx)
    ]).expect(200)
    const c = (await getSpace()).cards[0]
    expect(c).toMatchObject({ x: 300, y: 100, backgroundColor: null, isTodo: true, name: 'card cardA0000000001' })
  })

  it('keeps the newer name when an older rename arrives late, but only if the patch is dated', async () => {
    await send([op('updateCard', { id: 'cardA0000000001', name: 'newer', nameUpdatedAt: '2026-10-10T12:00:00.000Z' }, ctx)]).expect(200)
    await send([op('updateCard', { id: 'cardA0000000001', name: 'older', nameUpdatedAt: '2026-10-10T11:00:00.000Z', x: 5 }, ctx)]).expect(200)
    let c = (await getSpace()).cards[0]
    expect(c.name).toBe('newer')
    expect(c.x).toBe(5)
    // box renames and other-space edits don't send nameUpdatedAt: they still apply
    await send([op('updateCard', { id: 'cardA0000000001', name: 'undated' }, ctx)]).expect(200)
    c = (await getSpace()).cards[0]
    expect(c.name).toBe('undated')
  })

  it('skips a batch it has already applied (same operationIds)', async () => {
    const batch = [
      op('createCard', card('cardB0000000001'), ctx),
      op('updateUserCardsCreatedCount', { delta: 1 }, ctx),
      op('updateUserCardsCreatedCountRaw', { delta: 1 }, ctx)
    ]
    await send(batch).expect(200)
    await send(batch).expect(200)
    const user = (await t.http().get('/api/user').set('Authorization', me.apiKey).expect(200)).body
    expect(user.cardsCreatedCount).toBe(1)
    expect(user.cardsCreatedCountRaw).toBe(1)
    expect((await getSpace()).cards).toHaveLength(2)
  })

  it('treats creates as upserts (undo/redo re-sends the same id)', async () => {
    await send([op('createCard', card('cardA0000000001', { name: 'redo version' }), ctx)]).expect(200)
    const space = await getSpace()
    expect(space.cards).toHaveLength(1)
    expect(space.cards[0].name).toBe('redo version')
  })

  it('soft removes, restores and hard deletes cards', async () => {
    await send([
      op('createCard', card('cardC0000000001'), ctx),
      op('createCard', card('cardC0000000002'), ctx),
      op('updateCard', { id: 'cardA0000000001', isRemoved: true }, ctx),
      op('removeCard', card('cardC0000000001'), ctx),
      op('deleteCard', card('cardC0000000002'), ctx)
    ]).expect(200)
    let removed = (await t.http().get(`/api/space/${spaceId}/removed-cards`).set('Authorization', me.apiKey)).body
    expect(removed.map((c: Json) => c.id).sort()).toEqual(['cardA0000000001', 'cardC0000000001'])
    await send([op('restoreRemovedCard', card('cardC0000000001', { isRemoved: false }), ctx)]).expect(200)
    await send([op('deleteAllRemovedCards', { userId: me.id }, ctx)]).expect(200)
    removed = (await t.http().get(`/api/space/${spaceId}/removed-cards`).set('Authorization', me.apiKey)).body
    expect(removed).toEqual([])
    const space = await getSpace()
    expect(space.cards.map((c: Json) => c.id)).toEqual(['cardC0000000001'])
  })

  it('handles connections, boxes, lists and lines, including list removal unlinking its cards', async () => {
    await send([
      op('createList', { id: 'list0000000001', x: 0, y: 0, name: 'L', color: '#eee', resizeWidth: 200, height: 300, isCollapsed: false, z: 0, frameId: 0 }, ctx),
      op('createCard', card('cardL0000000001', { listId: 'list0000000001', listPositionIndex: 'a0' }), ctx),
      // MoveOrCopy order: connection before the box it points at
      op('createConnection', { id: 'conn0000000001', startItemId: 'cardA0000000001', endItemId: 'box00000000001', path: 'm0,0', color: '#f00' }, ctx),
      op('createBox', { id: 'box00000000001', x: 10, y: 10, resizeWidth: 100, resizeHeight: 100, color: '#0f0', name: 'B' }, ctx),
      op('createLine', { id: 'line0000000001', y: 400, color: '#00f', name: 'Line' }, ctx),
      op('updateConnection', { id: 'conn0000000001', name: 'label', labelIsVisible: true }, ctx),
      op('updateBox', { id: 'box00000000001', name: 'Box!' }, ctx),
      op('updateLine', { id: 'line0000000001', y: 420 }, ctx)
    ]).expect(200)
    let space = await getSpace()
    expect(space.connections[0]).toMatchObject({ id: 'conn0000000001', name: 'label', labelIsVisible: true, endItemId: 'box00000000001' })
    expect(space.boxes[0]).toMatchObject({ name: 'Box!' })
    expect(space.lines[0]).toMatchObject({ y: 420 })

    await send([
      op('removeList', { id: 'list0000000001', name: 'L' }, ctx),
      op('removeConnection', { id: 'conn0000000001' }, ctx),
      op('removeBox', { id: 'box00000000001' }, ctx),
      op('removeLine', { id: 'line0000000001' }, ctx)
    ]).expect(200)
    space = await getSpace()
    expect(space.lists).toEqual([])
    expect(space.connections).toEqual([])
    expect(space.boxes).toEqual([])
    expect(space.lines).toEqual([])
    const unlinked = space.cards.find((c: Json) => c.id === 'cardL0000000001')
    expect(unlinked).toMatchObject({ listId: null, listPositionIndex: null })
  })

  it('stores drawing strokes newest first, moves them via remove + create, and clears them', async () => {
    const stroke = (id: string, x: number) => [{ id, x, y: 1, color: '#000', diameter: 3 }, { id, x: x + 1, y: 2, color: '#000', diameter: 3 }]
    await send([
      op('createDrawingStroke', { stroke: stroke('stroke00000001', 1) }, ctx),
      op('createDrawingStroke', { stroke: stroke('stroke00000002', 10) }, ctx)
    ]).expect(200)
    let space = await getSpace()
    expect(space.drawingStrokes.map((s: Json[]) => s[0].id)).toEqual(['stroke00000002', 'stroke00000001'])
    expect(space.drawingStrokes[0]).toEqual(stroke('stroke00000002', 10))
    // moving stroke 1: remove then create with the same id puts it on top
    await send([
      op('removeDrawingStroke', { stroke: stroke('stroke00000001', 1) }, ctx),
      op('createDrawingStroke', { stroke: stroke('stroke00000001', 50) }, ctx)
    ]).expect(200)
    space = await getSpace()
    expect(space.drawingStrokes.map((s: Json[]) => s[0].id)).toEqual(['stroke00000001', 'stroke00000002'])
    expect(space.drawingStrokes[0][0].x).toBe(50)
    await send([op('clearDrawing', {}, ctx)]).expect(200)
    expect((await getSpace()).drawingStrokes).toEqual([])
  })

  it('handles tags by id and by name across the user\'s spaces', async () => {
    const tag = (id: string, name: string, color = '#abc') => ({ id, name, color, cardId: 'cardA0000000001', spaceId })
    await send([op('updateTags', { tags: [tag('tag00000000001', 'idea'), tag('tag00000000002', 'todo')] }, ctx)]).expect(200)
    expect((await getSpace()).tags.map((x: Json) => x.name).sort()).toEqual(['idea', 'todo'])
    await send([op('updateTagColorByName', { tag: { name: 'idea', color: '#f00' } }, ctx)]).expect(200)
    expect((await getSpace()).tags.find((x: Json) => x.name === 'idea').color).toBe('#f00')
    // envelope overwrites spaceId with the current space; removal still finds it
    await send([op('removeTag', { ...tag('tag00000000002', 'todo'), spaceId: 'someOtherSpace1' }, ctx)]).expect(200)
    await send([op('removeTagsByName', tag('tag00000000009', 'idea'), ctx)]).expect(200)
    expect((await getSpace()).tags).toEqual([])
  })

  it('updates, removes, restores and deletes spaces', async () => {
    await send([op('updateSpace', { id: spaceId, name: 'Renamed', background: 'https://x/bg.png', editedAt: '2026-10-10T10:00:00.000Z', editedByUserId: me.id }, ctx)]).expect(200)
    let space = await getSpace()
    expect(space).toMatchObject({ name: 'Renamed', background: 'https://x/bg.png', editedAt: '2026-10-10T10:00:00.000Z' })
    await send([op('removeSpace', { id: spaceId }, ctx)]).expect(200)
    space = await getSpace()
    expect(space.isRemoved).toBe(true)
    await send([op('deleteAllRemovedSpaces', { userId: me.id }, ctx)]).expect(200)
    await t.http().get(`/api/space/${spaceId}`).set('Authorization', me.apiKey).expect(404)
  })

  it('merges preferences from updateUser and ignores protected keys', async () => {
    await send([op('updateUser', { theme: 'dark', name: 'Rentorious', apiKey: 'hijack', stripeSubscriptionId: 'x', isModerator: true, email: 'evil@x.com' }, ctx)]).expect(200)
    const user = (await t.http().get('/api/user').set('Authorization', me.apiKey).expect(200)).body
    expect(user).toMatchObject({ theme: 'dark', name: 'Rentorious', apiKey: me.apiKey, isModerator: false, email: 'me@x.com' })
    expect(user.stripeSubscriptionId).toBeUndefined()
  })

  it('applies user-level ops even when the stamped spaceId is unknown', async () => {
    await send([op('updateUser', { theme: 'light', spaceId: 'notOnServerYet1' }, ctx)]).expect(200)
    const user = (await t.http().get('/api/user').set('Authorization', me.apiKey).expect(200)).body
    expect(user.theme).toBe('light')
  })

  it('reports failures the way the client parses them, and still commits the rest', async () => {
    const res = await send([
      op('createCard', card('cardD0000000001'), ctx),
      op('updateCard', { id: 'missingCard00001', x: 1 }, ctx),
      op('createCard', card('cardE0000000001', { spaceId: 'unknownSpace001' }), ctx),
      op('createCard', card('cardF0000000001'), ctx)
    ]).expect(400)
    expect(res.body.errors).toEqual([
      expect.objectContaining({ status: 404, name: 'updateCard' }),
      expect.objectContaining({ status: 404, name: 'createCard' })
    ])
    expect(Array.isArray(res.body.operations)).toBe(true)
    const ids = (await getSpace()).cards.map((c: Json) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['cardD0000000001', 'cardF0000000001']))
  })

  it('refuses edits to someone else\'s space with a non-critical 401', async () => {
    const res = await send([op('createCard', card('cardX0000000001'), ctx)], other).expect(400)
    expect(res.body.errors).toEqual([expect.objectContaining({ status: 401 })])
    const intruder = await send([op('updateSpace', { id: spaceId, name: 'pwned' }, { spaceId, userId: other.id })], other).expect(400)
    expect(intruder.body.errors[0].status).toBe(401)
    expect((await getSpace()).name).toBe('Ops')
  })

  it('accepts out-of-scope ops, array bodies and merged array bodies as no-ops', async () => {
    await send([
      { name: 'updateNotificationsIsRead', body: ['n1', 'n2'] },
      { name: 'updateUserVisitSpaces', body: { 0: { id: 'a' }, 1: { id: 'b' }, operationId: 'merged-1' } },
      op('updateFavoriteSpace', { spaceId, value: true }, ctx),
      op('createUserNotification', { type: 'createCard', recipientUserIds: [] }, ctx),
      op('someFutureOperation', { id: 'x' }, ctx)
    ]).expect(200)
  })

  it('puts cards into the Inbox via the op and the REST endpoint', async () => {
    await send([op('createCardInInbox', { id: 'inboxCard00001', name: 'from op', z: 1 }, ctx)]).expect(200)
    await t.http().post('/api/card/to-inbox').set('Authorization', me.apiKey).send({ id: 'inboxCard00002', name: 'from add page', z: 1 }).expect(200)
    const inbox = (await t.http().get('/api/user/inbox-space').set('Authorization', me.apiKey).expect(200)).body
    expect(inbox.cards.map((c: Json) => c.id).sort()).toEqual(['inboxCard00001', 'inboxCard00002'])
    expect(inbox.cards.every((c: Json) => c.x === 70)).toBe(true)
  })

  it('requires sign-in', async () => {
    const res = await t.http().post('/api/operations').send([]).expect(401)
    expect(res.body.status).toBe(401)
  })
})
