import { setup, TestContext } from './helpers'

describe('auth and user', () => {
  let t: TestContext
  beforeEach(async () => { t = await setup() })
  afterEach(async () => { await t.close() })

  const localUserState = {
    id: 'localUserId_abc123',
    color: '#c0ffee',
    name: 'Ognjen',
    theme: 'dark',
    themeIsSystem: false,
    lastSpaceId: 'someLocalSpace1',
    shouldShowMinimap: false,
    apiKey: '',
    // things a client could send that must never be stored
    stripeSubscriptionId: 'sub_fake',
    isModerator: true,
    isUpgraded: true,
    cardsCreatedCount: 99
  }

  it('signs up the first user with the client state and keeps its id and prefs', async () => {
    const res = await t.http().post('/api/user/sign-up')
      .send({ ...localUserState, email: 'Me@Example.com', password: 'hunter22', sessionToken: 'abc' })
      .expect(200)
    expect(res.body).toMatchObject({
      id: 'localUserId_abc123',
      email: 'me@example.com',
      name: 'Ognjen',
      color: '#c0ffee',
      theme: 'dark',
      lastSpaceId: 'someLocalSpace1',
      stripePlanIsPurchased: true,
      isModerator: false,
      cardsCreatedCount: 0
    })
    expect(typeof res.body.apiKey).toBe('string')
    expect(res.body.apiKey.length).toBeGreaterThan(30)
    expect(res.body.stripeSubscriptionId).toBeUndefined()
    expect(res.body.password).toBeUndefined()
    expect(res.body.sessionToken).toBeUndefined()
  })

  it('closes sign-up after the first user (first-user mode)', async () => {
    await t.http().post('/api/user/sign-up').send({ email: 'a@x.com', password: 'pw' }).expect(200)
    const res = await t.http().post('/api/user/sign-up').send({ email: 'b@x.com', password: 'pw' }).expect(403)
    expect(res.body).toMatchObject({ status: 403 })
  })

  it('reports a duplicate email the way the client reads it', async () => {
    await t.users.createUser({ email: 'a@x.com', password: 'pw', withInbox: false })
    const other = await setupOpenSignup()
    try {
      await other.users.createUser({ email: 'a@x.com', password: 'pw', withInbox: false })
      const res = await other.http().post('/api/user/sign-up').send({ email: 'A@x.com', password: 'pw' }).expect(409)
      expect(res.body).toMatchObject({ status: 409, type: 'unique violation' })
    } finally {
      await other.close()
    }
  })

  it('signs in, with errors as JSON carrying status in the body', async () => {
    await t.users.createUser({ email: 'me@x.com', password: 'right-password', withInbox: true })
    const bad = await t.http().post('/api/user/sign-in').send({ email: 'me@x.com', password: 'wrong' }).expect(401)
    expect(bad.body).toEqual({ status: 401, message: expect.any(String) })
    await t.http().post('/api/user/sign-in').send({ email: 'nobody@x.com', password: 'x' }).expect(401)
    const ok = await t.http().post('/api/user/sign-in').send({ email: 'ME@x.com', password: 'right-password' }).expect(200)
    expect(ok.body.apiKey).toEqual(expect.any(String))
  })

  it('gives a CLI-created user an Inbox and points lastSpaceId at it', async () => {
    const user = await t.users.createUser({ email: 'me@x.com', password: 'pw', withInbox: true })
    const me = await t.http().get('/api/user').set('Authorization', String(user.apiKey)).expect(200)
    const inbox = await t.http().get('/api/space/inbox').set('Authorization', String(user.apiKey)).expect(200)
    expect(me.body.lastSpaceId).toBe(inbox.body.id)
    const full = await t.http().get('/api/user/inbox-space').set('Authorization', String(user.apiKey)).expect(200)
    expect(full.body).toMatchObject({ id: inbox.body.id, name: 'Inbox', cards: [] })
  })

  it('replaces a lastSpaceId that points nowhere', async () => {
    const user = await t.users.createUser({ email: 'me@x.com', password: 'pw', prefs: { lastSpaceId: 'deletedHelloSpace' }, withInbox: false })
    const me = await t.http().get('/api/user').set('Authorization', String(user.apiKey)).expect(200)
    expect(me.body.lastSpaceId).not.toBe('deletedHelloSpace')
    const inbox = await t.http().get('/api/space/inbox').set('Authorization', String(user.apiKey)).expect(200)
    expect(me.body.lastSpaceId).toBe(inbox.body.id)
  })

  it('requires the raw apiKey for GET /user', async () => {
    const user = await t.users.createUser({ email: 'me@x.com', password: 'pw', withInbox: true })
    await t.http().get('/api/user').expect(401)
    await t.http().get('/api/user').set('Authorization', `Bearer ${user.apiKey}`).expect(401)
    await t.http().get('/api/user').set('Authorization', String(user.apiKey)).expect(200)
  })

  it('rate limits sign-in with status 429 in the body', async () => {
    const limited = await setup({ signInRateLimit: { max: 3, windowMs: 60_000 } })
    try {
      for (let i = 0; i < 3; i++) await limited.http().post('/api/user/sign-in').send({ email: 'x@x.com', password: 'x' }).expect(401)
      const res = await limited.http().post('/api/user/sign-in').send({ email: 'x@x.com', password: 'x' }).expect(429)
      expect(res.body).toMatchObject({ status: 429 })
    } finally {
      await limited.close()
    }
  })

  async function setupOpenSignup () {
    // a second app on the same database, with sign-up open
    const { setup: s } = await import('./helpers')
    const ctx = await s({ allowSignup: 'true' })
    return ctx
  }
})
