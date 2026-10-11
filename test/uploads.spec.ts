import { createUploadToken } from '../src/files/upload-token'
import { setup, TestContext } from './helpers'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('uploads and /files', () => {
  let t: TestContext
  let me: { id: string, apiKey: string }
  let other: { id: string, apiKey: string }
  const spaceId = 'uploadSpace123456789a'
  const auth = (u: { apiKey: string }) => ({ Authorization: u.apiKey })

  async function start (overrides = {}) {
    t = await setup(overrides)
    const a = await t.users.createUser({ email: 'me@x.com', password: 'pw', withInbox: true })
    const b = await t.users.createUser({ email: 'other@x.com', password: 'pw', withInbox: true })
    me = { id: String(a.id), apiKey: String(a.apiKey) }
    other = { id: String(b.id), apiKey: String(b.apiKey) }
    await t.http().post('/api/space').set(auth(me)).send({ id: spaceId, name: 'Uploads' }).expect(200)
  }
  afterEach(async () => { await t.close() })

  async function presign (key: string, type = 'image/png', user = me): Promise<Json> {
    const res = await t.http().post('/api/upload/presigned-post').set(auth(user)).send({ key, type, requestSpaceId: spaceId }).expect(200)
    return res.body
  }

  /** What the client's uploadFile does: every field, then the file, no auth header. */
  function postForm (fields: Record<string, string>, content: Buffer, filename = 'x.png') {
    let req = t.http().post('/api/upload/direct')
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v)
    return req.attach('file', content, { filename, contentType: 'application/octet-stream' })
  }

  describe('with the default config', () => {
    beforeEach(async () => { await start() })

    it('presigns, accepts the form and serves the file back with its type', async () => {
      const key = 'card1234567890abcdefg/Screenshot-2026.PNG'
      const post = await presign(key)
      expect(post.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/upload\/direct$/)
      expect(post.fields.key).toBe(key)
      expect(typeof post.fields.token).toBe('string')

      const content = Buffer.from('fake png bytes')
      const up = await postForm(post.fields, content).expect(200)
      expect(up.body).toEqual({})

      const res = await t.http().get(`/files/${key}`).expect(200)
      expect(res.headers['content-type']).toBe('image/png')
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(res.headers['accept-ranges']).toBe('bytes')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(Buffer.from(res.body).toString()).toBe('fake png bytes')
    })

    it('serves byte ranges so audio and video can seek', async () => {
      const key = 'card1234567890abcdefg/clip.mp4'
      await postForm((await presign(key, 'video/mp4')).fields, Buffer.from('0123456789')).expect(200)
      const parse = (res: Json, cb: (err: Error | null, body: Buffer) => void) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => cb(null, Buffer.concat(chunks)))
      }

      const mid = await t.http().get(`/files/${key}`).set('Range', 'bytes=2-5').buffer(true).parse(parse).expect(206)
      expect(mid.headers['content-range']).toBe('bytes 2-5/10')
      expect(mid.headers['content-length']).toBe('4')
      expect(mid.body.toString()).toBe('2345')

      const tail = await t.http().get(`/files/${key}`).set('Range', 'bytes=-3').buffer(true).parse(parse).expect(206)
      expect(tail.body.toString()).toBe('789')

      const open = await t.http().get(`/files/${key}`).set('Range', 'bytes=7-').buffer(true).parse(parse).expect(206)
      expect(open.body.toString()).toBe('789')

      const past = await t.http().get(`/files/${key}`).set('Range', 'bytes=20-30').expect(416)
      expect(past.headers['content-range']).toBe('bytes */10')
    })

    it('sandboxes types a browser would run as a page', async () => {
      const key = 'card1234567890abcdefg/drawing.svg'
      await postForm((await presign(key, 'image/svg+xml')).fields, Buffer.from('<svg/>')).expect(200)
      const res = await t.http().get(`/files/${key}`).expect(200)
      expect(res.headers['content-security-policy']).toMatch(/^sandbox/)
    })

    it('needs a signed-in user', async () => {
      await t.http().post('/api/upload/presigned-post').send({ key: 'a/b.png', type: 'image/png' }).expect(401)
      await t.http().post('/api/upload/presigned-post/multiple').send({ files: [{ key: 'a/b.png' }] }).expect(401)
    })

    it('only allows <id>/<filename> keys', async () => {
      for (const key of ['nofolder.png', 'a/b/c.png', 'a/..', 'a/.', '../x.png', 'a/has space.png', 'a/', '/x.png', 'a/ü.png', '']) {
        await t.http().post('/api/upload/presigned-post').set(auth(me)).send({ key, type: 'image/png', requestSpaceId: spaceId }).expect(400)
      }
    })

    it('refuses spaces you can\'t edit, but allows a space that doesn\'t exist yet', async () => {
      await t.http().post('/api/upload/presigned-post').set(auth(other)).send({ key: 'a/b.png', type: 'image/png', requestSpaceId: spaceId }).expect(401)
      await t.http().post('/api/upload/presigned-post').set(auth(other)).send({ key: 'a/b.png', type: 'image/png', requestSpaceId: 'notCreatedYet12345678' }).expect(200)
    })

    it('presigns several files in order', async () => {
      const files = [{ key: 'c1/a.png', type: 'image/png', size: 10 }, { key: 'c2/b.pdf', type: 'application/pdf', size: 20 }]
      const res = await t.http().post('/api/upload/presigned-post/multiple').set(auth(me)).send({ files, requestSpaceId: spaceId }).expect(200)
      expect(res.body.map((p: Json) => p.fields.key)).toEqual(['c1/a.png', 'c2/b.pdf'])
      await postForm(res.body[1].fields, Buffer.from('%PDF')).expect(200)
      const pdf = await t.http().get('/files/c2/b.pdf').expect(200)
      expect(pdf.headers['content-type']).toBe('application/pdf')
    })

    it('refuses a too-large file when presigning several', async () => {
      const files = [{ key: 'c1/a.png', type: 'image/png', size: 10 * 1024 * 1024 }]
      await t.http().post('/api/upload/presigned-post/multiple').set(auth(me)).send({ files, requestSpaceId: spaceId }).expect(413)
    })

    it('rejects forged, mismatched and expired tokens and stores nothing', async () => {
      const key = 'card1234567890abcdefg/a.png'
      const { fields } = await presign(key)
      await postForm({ key, token: fields.token + 'x' }, Buffer.from('x')).expect(401)
      await postForm({ key: 'card1234567890abcdefg/other.png', token: fields.token }, Buffer.from('x')).expect(401)
      await postForm({ key }, Buffer.from('x')).expect(401)
      const expired = createUploadToken({ key, type: 'image/png', userId: me.id, maxBytes: 1e9, exp: Date.now() - 1 }, 'test-upload-secret')
      await postForm({ key, token: expired }, Buffer.from('x')).expect(401)
      const wrongSecret = createUploadToken({ key, type: 'image/png', userId: me.id, maxBytes: 1e9, exp: Date.now() + 60_000 }, 'not-the-secret')
      await postForm({ key, token: wrongSecret }, Buffer.from('x')).expect(401)
      await t.http().get(`/files/${key}`).expect(404)
    })

    it('answers a form without a file with 400', async () => {
      const key = 'card1234567890abcdefg/a.png'
      const { fields } = await presign(key)
      await t.http().post('/api/upload/direct').field('key', key).field('token', fields.token).expect(400)
      await t.http().post('/api/upload/direct').send({ key }).expect(400)
    })

    it('answers unknown files with JSON 404', async () => {
      const res = await t.http().get('/files/nope1234567890/missing.png').expect(404)
      expect(res.body).toEqual({ status: 404, message: 'file not found' })
      await t.http().get('/files/only-one-segment').expect(404)
    })
  })

  describe('with a small size limit', () => {
    beforeEach(async () => { await start({ uploadMaxBytes: 1024 }) })

    it('aborts past UPLOAD_MAX_BYTES and keeps nothing', async () => {
      const key = 'card1234567890abcdefg/big.bin'
      const { fields } = await presign(key, 'application/octet-stream')
      await postForm(fields, Buffer.alloc(4096, 1)).expect(413)
      await t.http().get(`/files/${key}`).expect(404)
    })
  })
})
