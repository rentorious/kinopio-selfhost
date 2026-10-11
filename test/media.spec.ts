import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import type { MediaResult } from '../src/media/contract'
import { MediaService } from '../src/media/media.service'
import { setup, op, TestContext } from './helpers'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Collects JSON messages from a socket; `next` waits for one that matches. */
class Inbox {
  private messages: Json[] = []
  private waiters: Array<{ match: (m: Json) => boolean, resolve: (m: Json) => void }> = []
  constructor (readonly ws: WebSocket) {
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString())
      const w = this.waiters.find(x => x.match(msg))
      if (w) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg) } else this.messages.push(msg)
    })
  }

  next (match: (m: Json) => boolean, timeoutMs = 3000): Promise<Json> {
    const i = this.messages.findIndex(match)
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const w = { match, resolve }
      this.waiters.push(w)
      setTimeout(() => {
        const at = this.waiters.indexOf(w)
        if (at >= 0) { this.waiters.splice(at, 1); reject(new Error('timed out waiting for a message')) }
      }, timeoutMs).unref()
    })
  }

  send (msg: Json): void { this.ws.send(JSON.stringify(msg)) }

  close (): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise(resolve => { this.ws.once('close', () => resolve()); this.ws.close() })
  }
}

function open (url: string, headers: Record<string, string> = {}): Promise<Inbox> {
  const ws = new WebSocket(url, { headers })
  const inbox = new Inbox(ws)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(inbox))
    ws.once('error', reject)
  })
}

const VIDEO = Buffer.from('not really a video, but bytes are bytes')

describe('media summaries', () => {
  let t: TestContext
  let base: string
  let me: { id: string, apiKey: string }
  let other: { id: string, apiKey: string }
  let sockets: Inbox[]
  const spaceId = 'mediaSpace1234567890a'
  const cardId = 'placeholderCard123456'
  const auth = (u: { apiKey: string }) => ({ Authorization: u.apiKey })
  const media = () => t.app.get(MediaService)

  async function start (overrides: Json = {}) {
    t = await setup(overrides)
    await t.app.listen(0, '127.0.0.1')
    base = `127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`
    const a = await t.users.createUser({ email: 'me@x.com', password: 'pw', withInbox: true })
    const b = await t.users.createUser({ email: 'other@x.com', password: 'pw', withInbox: true })
    me = { id: String(a.id), apiKey: String(a.apiKey) }
    other = { id: String(b.id), apiKey: String(b.apiKey) }
    await t.http().post('/api/space').set(auth(me)).send({
      id: spaceId, name: 'Lectures', cards: [{ id: cardId, x: 300, y: 200, z: 1, name: '⬬⬭' }]
    }).expect(200)
    sockets = []
  }
  afterEach(async () => {
    await Promise.all(sockets.map(s => s.close()))
    await t.close()
  })

  async function worker (activeJobId?: string): Promise<Inbox> {
    const w = await open(`ws://${base}/api/worker/ws`, { Authorization: 'Bearer test-worker-token' })
    sockets.push(w)
    w.send({ type: 'hello', version: '1', model: 'large-v3', gpu: 'Test GPU', ...(activeJobId ? { activeJobId } : {}) })
    await waitFor(async () => (await media().status()).online)
    return w
  }

  /** A browser tab on the space, to see live card updates. */
  async function tab (): Promise<Inbox> {
    const s = await open(`ws://${base}/api/ws`)
    sockets.push(s)
    s.send({ message: { name: 'joinSpaceRoom' }, spaceId, user: { id: me.id }, clientId: 'tab1', credentials: { apiKey: me.apiKey } })
    await new Promise(resolve => setTimeout(resolve, 100))
    return s
  }

  function upload (fields: Json = {}, content = VIDEO, user = me) {
    const all: Json = { spaceId, cardId, fileName: 'lecture.mp4', startMs: 300000, endMs: 3300000, language: 'en', topic: 'rhizosphere', x: 300, y: 200, ...fields }
    let req = t.http().post('/api/media-summaries').set(auth(user))
    for (const [k, v] of Object.entries(all)) req = req.field(k, String(v))
    return req.attach('file', content, { filename: 'lecture.mp4', contentType: 'video/mp4' })
  }

  async function cardName (id = cardId, space = spaceId): Promise<string> {
    const res = await t.http().get(`/api/space/${space}`).set(auth(me)).expect(200)
    return res.body.cards.find((c: Json) => c.id === id)?.name
  }

  async function jobStatus (jobId: string): Promise<Json> {
    await media().idle()
    return (await t.http().get(`/api/media-summaries/${jobId}`).set(auth(me)).expect(200)).body
  }

  const tmpFiles = () => fs.readdirSync(t.app.get(MediaService)['config'].media.tmpDir)

  function result (overrides: Partial<MediaResult> = {}): MediaResult {
    return {
      title: 'The rhizosphere microbiome',
      card: '# The rhizosphere microbiome\n## Summary\nRoots feed microbes that protect the vine.\n## Key points\n- Nitrogen fixation\n- Phosphate solubilization',
      sections: [
        { heading: 'What the rhizosphere is', startMs: 300000, endMs: 600000, text: 'It is a thin layer around the roots.' },
        { heading: 'Methods', startMs: 600000, endMs: 900000, text: 'Culture-independent techniques.' }
      ],
      corrections: '- rhesus fur → rhizosphere',
      transcriber: { model: 'large-v3', language: 'en' },
      ...overrides
    }
  }

  async function waitFor (fn: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await fn()) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('condition not met in time')
  }

  describe('with the default config', () => {
    beforeEach(async () => { await start() })

    it('reports the worker offline and refuses uploads before reading them', async () => {
      const status = await t.http().get('/api/media-summaries/status').set(auth(me)).expect(200)
      expect(status.body).toMatchObject({ online: false, busy: false, queued: 0, model: null })
      const res = await upload().expect(503)
      expect(res.body.error).toBe('transcriber_offline')
      expect(tmpFiles()).toEqual([])
    })

    it('rejects a worker with the wrong token', async () => {
      await expect(open(`ws://${base}/api/worker/ws`, { Authorization: 'Bearer nope' })).rejects.toThrow(/401/)
      await expect(open(`ws://${base}/api/worker/ws`)).rejects.toThrow(/401/)
      await t.http().get('/api/worker/jobs/x/media').expect(401)
      await t.http().get('/api/worker/jobs/x/media').set('Authorization', 'Bearer nope').expect(401)
    })

    it('runs a job end to end: upload, offer, download, progress, result, transcript space and summary card', async () => {
      const w = await worker()
      const browser = await tab()
      const status = await t.http().get('/api/media-summaries/status').set(auth(me)).expect(200)
      expect(status.body).toMatchObject({ online: true, model: 'large-v3' })

      const up = await upload().expect(202)
      const jobId = up.body.jobId
      const offer = await w.next(m => m.type === 'job')
      expect(offer.job).toMatchObject({ jobId, fileName: 'lecture.mp4', mimeType: 'video/mp4', bytes: VIDEO.length, startMs: 300000, endMs: 3300000, language: 'en', topic: 'rhizosphere' })
      expect(tmpFiles()).toEqual([jobId])
      expect(await jobStatus(jobId)).toMatchObject({ status: 'downloading' })
      expect(await cardName()).toBe('⏳ lecture.mp4 · sending to transcriber')
      await browser.next(m => m.message?.updates?.[0]?.name === '⏳ lecture.mp4 · sending to transcriber')

      // the file, only for the worker
      await t.http().get(offer.job.mediaPath).set(auth(me)).expect(401)
      const file = await t.http().get(offer.job.mediaPath).set('Authorization', 'Bearer test-worker-token').buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)))
      }).expect(200)
      expect(Buffer.compare(file.body, VIDEO)).toBe(0)

      w.send({ type: 'downloaded', jobId })
      await waitFor(async () => (await jobStatus(jobId)).status === 'transcribing')
      expect(tmpFiles()).toEqual([])

      w.send({ type: 'progress', jobId, stage: 'transcribing', percent: 42 })
      await waitFor(async () => (await cardName()) === '⏳ lecture.mp4 · transcribing 42%')
      w.send({ type: 'progress', jobId, stage: 'summarizing' })
      await waitFor(async () => (await cardName()) === '⏳ lecture.mp4 · summarizing')

      await t.http().post(offer.job.resultPath).set('Authorization', 'Bearer test-worker-token').send(result()).expect(200)
      const done = await jobStatus(jobId)
      expect(done.status).toBe('done')

      // transcript space: header, one card per section, corrections
      const transcript = (await t.http().get(`/api/space/${done.transcriptSpaceId}`).set(auth(me)).expect(200)).body
      expect(transcript.name).toBe('Transcript: The rhizosphere microbiome')
      expect(transcript.userId).toBe(me.id)
      expect(transcript.privacy).toBe('private')
      const names = transcript.cards.map((c: Json) => c.name)
      expect(names[0]).toMatch(/^# The rhizosphere microbiome\n\n🎧 lecture\.mp4 · 5:00–55:00 \(50 min\) · English\n\nSummary card: http:\/\/127\.0\.0\.1:\d+\/lectures-mediaSpace1234567890a$/)
      expect(names[1]).toBe('**5:00–10:00 · What the rhizosphere is**\n\nIt is a thin layer around the roots.')
      expect(names[3]).toBe('**Corrections**\n\n- rhesus fur → rhizosphere')
      const ys = transcript.cards.map((c: Json) => c.y)
      expect([...ys].sort((a, b) => a - b)).toEqual(ys)

      // the placeholder card became the summary card, linking to the transcript
      const summary = await cardName()
      expect(summary.startsWith('# The rhizosphere microbiome\n## Summary')).toBe(true)
      expect(summary).toContain('🎧 lecture.mp4 · 5:00–55:00 (50 min) · English')
      expect(summary).toMatch(new RegExp(`\\n🎧 [^\\n]*\\nhttp://127\\.0\\.0\\.1:\\d+/transcript-the-rhizosphere-microbiome-${done.transcriptSpaceId}$`))
      await browser.next(m => m.message?.updates?.[0]?.name === summary)

      const spaces = (await t.http().get('/api/user/spaces').set(auth(me)).expect(200)).body
      expect(spaces.map((s: Json) => s.id)).toContain(done.transcriptSpaceId)
      expect(tmpFiles()).toEqual([])
    })

    it('fails the job on an invalid result and says why', async () => {
      const w = await worker()
      const jobId = (await upload().expect(202)).body.jobId
      const offer = await w.next(m => m.type === 'job')
      w.send({ type: 'downloaded', jobId })
      const bad = result({ card: 'x'.repeat(5000), sections: [] })
      const res = await t.http().post(offer.job.resultPath).set('Authorization', 'Bearer test-worker-token').send(bad).expect(422)
      expect(res.body.errors).toEqual(expect.arrayContaining([expect.stringMatching(/card is 5000 characters/), expect.stringMatching(/sections/)]))
      expect(await jobStatus(jobId)).toMatchObject({ status: 'failed' })
      expect(await cardName()).toMatch(/^⚠️ lecture\.mp4 · the transcriber sent an invalid result/)
    })

    it('cancels when the placeholder card is removed, and tells the worker', async () => {
      const w = await worker()
      const jobId = (await upload().expect(202)).body.jobId
      await w.next(m => m.type === 'job')
      await t.http().post('/api/operations').set(auth(me)).send([op('removeCard', { id: cardId }, { spaceId, userId: me.id })]).expect(200)
      expect(await w.next(m => m.type === 'cancel')).toEqual({ type: 'cancel', jobId })
      expect(await jobStatus(jobId)).toMatchObject({ status: 'canceled' })
      expect(tmpFiles()).toEqual([])
      await t.http().get(`/api/worker/jobs/${jobId}/media`).set('Authorization', 'Bearer test-worker-token').expect(404)
    })

    it('cancels through DELETE, for the owner only', async () => {
      const w = await worker()
      const jobId = (await upload().expect(202)).body.jobId
      await w.next(m => m.type === 'job')
      await t.http().delete(`/api/media-summaries/${jobId}`).set(auth(other)).expect(404)
      await t.http().delete(`/api/media-summaries/${jobId}`).set(auth(me)).expect(200)
      await w.next(m => m.type === 'cancel')
      expect(await cardName()).toBe('✖ lecture.mp4 · canceled')
    })

    it('runs one job at a time and moves on when the worker reports a failure', async () => {
      const w = await worker()
      const secondCard = 'secondPlaceholder1234'
      await t.http().post('/api/operations').set(auth(me)).send([op('createCard', { id: secondCard, x: 10, y: 10, name: 'p' }, { spaceId, userId: me.id })]).expect(200)
      const first = (await upload().expect(202)).body.jobId
      const second = (await upload({ cardId: secondCard, fileName: 'two.mp3' }).expect(202)).body.jobId
      await w.next(m => m.type === 'job' && m.job.jobId === first)
      expect(await jobStatus(second)).toMatchObject({ status: 'queued' })
      expect(await cardName(secondCard)).toBe('⏳ two.mp3 · waiting for transcriber')
      expect((await media().status()).busy).toBe(true)

      w.send({ type: 'failed', jobId: first, reason: 'no audio stream in the file' })
      await w.next(m => m.type === 'job' && m.job.jobId === second)
      expect(await jobStatus(first)).toMatchObject({ status: 'failed', error: 'no audio stream in the file' })
      expect(await cardName()).toBe('⚠️ lecture.mp4 · no audio stream in the file · drop the file again to retry')
    })

    it('keeps the job when the worker reconnects with it, and fails it if the worker lost it', async () => {
      const w = await worker()
      const jobId = (await upload().expect(202)).body.jobId
      await w.next(m => m.type === 'job')
      w.send({ type: 'downloaded', jobId })
      await waitFor(async () => (await jobStatus(jobId)).status === 'transcribing')
      await w.close()
      await waitFor(async () => !(await media().status()).online)

      const back = await worker(jobId)
      back.send({ type: 'progress', jobId, stage: 'transcribing', percent: 80 })
      await waitFor(async () => (await cardName()) === '⏳ lecture.mp4 · transcribing 80%')

      await back.close()
      await worker() // restarted without the job
      await waitFor(async () => (await jobStatus(jobId)).status === 'failed')
      expect((await jobStatus(jobId)).error).toBe('the transcriber restarted')
    })

    it('validates the form before reading the file', async () => {
      await worker()
      for (const [fields, msg] of [
        [{ spaceId: 'bad id!' }, /spaceId/],
        [{ cardId: '' }, /cardId/],
        [{ startMs: 5000, endMs: 4000 }, /startMs/],
        [{ startMs: 0, endMs: 181 * 60_000 }, /180 minutes/],
        [{ language: 'english' }, /language/],
        [{ fileName: '' }, /fileName/]
      ] as Array<[Json, RegExp]>) {
        const res = await upload(fields).expect(400)
        expect(res.body.message).toMatch(msg)
      }
      await upload({}, VIDEO, other).expect(401)
      expect(tmpFiles()).toEqual([])
    })

    it('ignores progress for a job the worker does not have', async () => {
      const w = await worker()
      w.send({ type: 'progress', jobId: 'someOtherJob', stage: 'transcribing', percent: 5 })
      expect(await w.next(m => m.type === 'cancel')).toEqual({ type: 'cancel', jobId: 'someOtherJob' })
    })
  })

  describe('limits and housekeeping', () => {
    it('refuses files over MEDIA_MAX_BYTES and keeps nothing', async () => {
      await start({ media: { workerToken: 'test-worker-token', tmpDir: fs.mkdtempSync('/tmp/kinopio-media-'), maxBytes: 16, maxMinutes: 180, tmpMaxAgeMs: 3_600_000, offlineGraceMs: 120_000 } })
      await worker()
      await upload().expect(413)
      await media().idle()
      expect(tmpFiles()).toEqual([])
      expect(await cardName()).toBe('⚠️ lecture.mp4 · the file is too large · drop the file again to retry')
    })

    it('fails a job whose worker stays gone past the grace period', async () => {
      await start({ media: { workerToken: 'test-worker-token', tmpDir: fs.mkdtempSync('/tmp/kinopio-media-'), maxBytes: 1e6, maxMinutes: 180, tmpMaxAgeMs: 3_600_000, offlineGraceMs: 200 } })
      const w = await worker()
      const jobId = (await upload().expect(202)).body.jobId
      await w.next(m => m.type === 'job')
      await w.close()
      await waitFor(async () => (await jobStatus(jobId)).status === 'failed')
      expect((await jobStatus(jobId)).error).toBe('the transcriber went offline')
      expect(tmpFiles()).toEqual([])
    })

    it('sweeps queued files that waited too long, and stray files', async () => {
      await start({ media: { workerToken: 'test-worker-token', tmpDir: fs.mkdtempSync('/tmp/kinopio-media-'), maxBytes: 1e6, maxMinutes: 180, tmpMaxAgeMs: 50, offlineGraceMs: 120_000 } })
      const w = await worker()
      const secondCard = 'secondPlaceholder1234'
      await t.http().post('/api/operations').set(auth(me)).send([op('createCard', { id: secondCard, x: 10, y: 10, name: 'p' }, { spaceId, userId: me.id })]).expect(200)
      await upload().expect(202)
      await w.next(m => m.type === 'job')
      const queued = (await upload({ cardId: secondCard }).expect(202)).body.jobId
      fs.writeFileSync(`${media()['config'].media.tmpDir}/stray`, 'x')
      await new Promise(resolve => setTimeout(resolve, 100))
      await media().sweep()
      expect(await jobStatus(queued)).toMatchObject({ status: 'failed', error: 'waited too long for the transcriber' })
      expect(tmpFiles()).not.toContain('stray')
      expect(tmpFiles()).not.toContain(queued)
    })

    it('fails unfinished jobs and empties the temp dir when the server restarts', async () => {
      await start()
      const w = await worker()
      const jobId = (await upload().expect(202)).body.jobId
      await w.next(m => m.type === 'job')
      const tmpDir = media()['config'].media.tmpDir
      await media().onModuleInit() // what a fresh boot does
      expect(await jobStatus(jobId)).toMatchObject({ status: 'failed', error: 'the server restarted' })
      expect(fs.readdirSync(tmpDir)).toEqual([])
    })
  })
})
