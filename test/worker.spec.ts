import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { formatTimestamp, parseTimestamp, validateResult } from '../src/media/contract'
import { MediaService } from '../src/media/media.service'
import { loadConfig, WorkerConfig } from '../worker/src/config'
import { Worker } from '../worker/src/connection'
import { claudeArgs, fallbackResult, readOutput } from '../worker/src/summarize'
import { hasRepetitionLoop } from '../worker/src/whisper'
import { op, setup, TestContext } from './helpers'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const BIN = path.join(__dirname, 'fixtures', 'worker-bin')

describe('PC worker against the real server', () => {
  let t: TestContext
  let me: { id: string, apiKey: string }
  let worker: Worker
  let config: WorkerConfig
  let tmp: string
  let logs: string[]
  const spaceId = 'workerSpace123456789a'
  const cardId = 'workerPlaceholder1234'
  const auth = () => ({ Authorization: me.apiKey })

  async function start (env: Record<string, string> = {}) {
    t = await setup()
    await t.app.listen(0, '127.0.0.1')
    const port = (t.app.getHttpServer().address() as AddressInfo).port
    const user = await t.users.createUser({ email: 'me@x.com', password: 'pw', withInbox: true })
    me = { id: String(user.id), apiKey: String(user.apiKey) }
    await t.http().post('/api/space').set(auth()).send({ id: spaceId, name: 'Talks', cards: [{ id: cardId, x: 10, y: 10, z: 1, name: 'p' }] }).expect(200)

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kinopio-worker-'))
    fs.writeFileSync(path.join(tmp, 'ggml-large-v3.bin'), 'model')
    fs.writeFileSync(path.join(tmp, 'ggml-loopy.bin'), 'model')
    fs.writeFileSync(path.join(tmp, 'ggml-large-v2.bin'), 'model')
    config = loadConfig({
      SERVER_URL: `http://127.0.0.1:${port}`,
      WORKER_TOKEN: 'test-worker-token',
      WHISPER_BIN: path.join(BIN, 'whisper-cli'),
      WHISPER_MODEL: path.join(tmp, 'ggml-large-v3.bin'),
      WHISPER_FALLBACK_MODEL: path.join(tmp, 'ggml-large-v2.bin'),
      FFMPEG_BIN: path.join(BIN, 'ffmpeg'),
      FFPROBE_BIN: path.join(BIN, 'ffprobe'),
      CLAUDE_BIN: path.join(BIN, 'claude'),
      JOB_DIR: path.join(tmp, 'jobs'),
      WORKER_GPU_NAME: 'Test GPU',
      ...env
    })
    fs.mkdirSync(config.jobDir, { recursive: true })
    logs = []
    worker = new Worker(config, msg => logs.push(msg))
    worker.start()
    await waitFor(async () => (await t.app.get(MediaService).status()).online)
  }

  afterEach(async () => {
    await worker.stop()
    await t.close()
    for (const key of ['FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_ARGS_LOG', 'FAKE_WHISPER_LOG']) delete process.env[key]
  })

  async function waitFor (fn: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await fn()) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`condition not met in time; worker log:\n${logs.join('\n')}`)
  }

  function upload (content = Buffer.from('fake media bytes'), fields: Json = {}) {
    const all: Json = { spaceId, cardId, fileName: 'talk.mp4', startMs: 60000, endMs: 600000, language: 'en', topic: 'rhizosphere, vineyards', ...fields }
    let req = t.http().post('/api/media-summaries').set(auth())
    for (const [k, v] of Object.entries(all)) req = req.field(k, String(v))
    return req.attach('file', content, { filename: 'talk.mp4', contentType: 'video/mp4' })
  }

  async function finished (jobId: string): Promise<Json> {
    let job: Json = {}
    await waitFor(async () => {
      job = (await t.http().get(`/api/media-summaries/${jobId}`).set(auth()).expect(200)).body
      return ['done', 'failed', 'canceled'].includes(job.status)
    })
    return job
  }

  async function card (): Promise<string> {
    const space = (await t.http().get(`/api/space/${spaceId}`).set(auth()).expect(200)).body
    return space.cards.find((c: Json) => c.id === cardId).name
  }

  const jobDirs = () => fs.readdirSync(config.jobDir)

  it('transcribes, summarizes and builds the transcript space; leaves no files behind', async () => {
    await start()
    const argsLog = path.join(tmp, 'claude-args.log')
    process.env.FAKE_CLAUDE_ARGS_LOG = argsLog
    const jobId = (await upload().expect(202)).body.jobId
    const job = await finished(jobId)
    expect(job.status).toBe('done')

    const summary = await card()
    expect(summary).toMatch(/^# The rhizosphere microbiome\n## Summary\nTopic hint was: rhizosphere, vineyards\./)
    expect(summary).toContain('🎧 talk.mp4 · 1:00–10:00 (9 min) · English')

    const transcript = (await t.http().get(`/api/space/${job.transcriptSpaceId}`).set(auth()).expect(200)).body
    const names: string[] = transcript.cards.map((c: Json) => c.name)
    expect(names.some(n => n.startsWith('**1:00–1:04 · Part 1**') && n.includes('today the rhizosphere microbiome'))).toBe(true)
    expect(names.some(n => n.startsWith('**Corrections**'))).toBe(true)

    // the headless session ran locked down
    const args = JSON.parse(fs.readFileSync(argsLog, 'utf8').trim().split('\n')[0])
    expect(args).toEqual(expect.arrayContaining(['-p', '--tools', 'Read,Write,Edit,Glob', '--strict-mcp-config', '--restricted', '--no-session-persistence']))
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('mcp__*')

    expect(jobDirs()).toEqual([])
    expect(fs.readdirSync(t.app.get(MediaService)['config'].media.tmpDir)).toEqual([])
  })

  it('retries the summary once with the problems listed', async () => {
    await start()
    process.env.FAKE_CLAUDE_MODE = 'bad-once'
    const argsLog = path.join(tmp, 'claude-args.log')
    process.env.FAKE_CLAUDE_ARGS_LOG = argsLog
    const job = await finished((await upload().expect(202)).body.jobId)
    expect(job.status).toBe('done')
    const calls = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(calls).toHaveLength(2)
    expect(calls[1][calls[1].indexOf('-p') + 1]).toMatch(/Your previous attempt had these problems[\s\S]*title is required/)
  })

  it('falls back to the transcript alone when the summary fails twice', async () => {
    await start()
    process.env.FAKE_CLAUDE_MODE = 'bad'
    const job = await finished((await upload().expect(202)).body.jobId)
    expect(job.status).toBe('done')
    expect(await card()).toMatch(/^# talk\.mp4\n\nSummary failed; the transcript is attached\./)
    const transcript = (await t.http().get(`/api/space/${job.transcriptSpaceId}`).set(auth()).expect(200)).body
    expect(transcript.cards.some((c: Json) => c.name.includes('rhesus fur'))).toBe(true)
  })

  it('reruns whisper with the fallback model when it loops', async () => {
    await start()
    await worker.stop()
    const whisperLog = path.join(tmp, 'whisper.log')
    process.env.FAKE_WHISPER_LOG = whisperLog
    config.whisperModel = path.join(tmp, 'ggml-loopy.bin')
    worker = new Worker(config, msg => logs.push(msg))
    worker.start()
    await waitFor(async () => (await t.app.get(MediaService).status()).online)
    const job = await finished((await upload().expect(202)).body.jobId)
    expect(job.status).toBe('done')
    expect(fs.readFileSync(whisperLog, 'utf8').trim().split('\n').map(p => path.basename(p))).toEqual(['ggml-loopy.bin', 'ggml-large-v2.bin'])
  }, 20_000)

  it('reports files without audio as a failure on the card', async () => {
    await start()
    const job = await finished((await upload(Buffer.from('NOAUDIO video')).expect(202)).body.jobId)
    expect(job).toMatchObject({ status: 'failed', error: 'the file has no audio' })
    expect(await card()).toBe('⚠️ talk.mp4 · the file has no audio · drop the file again to retry')
    expect(jobDirs()).toEqual([])
  })

  it('stops the session and deletes the job folder when the card is removed', async () => {
    await start()
    process.env.FAKE_CLAUDE_MODE = 'slow'
    const jobId = (await upload().expect(202)).body.jobId
    await waitFor(async () => (await t.http().get(`/api/media-summaries/${jobId}`).set(auth())).body.status === 'summarizing')
    await t.http().post('/api/operations').set(auth()).send([op('removeCard', { id: cardId }, { spaceId, userId: me.id })]).expect(200)
    await waitFor(() => !worker.busyWith && jobDirs().length === 0)
    expect((await finished(jobId)).status).toBe('canceled')
    expect(logs.join('\n')).toMatch(/canceled/)
  })
})

describe('worker pieces', () => {
  it('reads the session output folder, front matter and all', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinopio-out-'))
    fs.mkdirSync(path.join(dir, 'output', 'transcript'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'output', 'card.md'), '# Title here\n## Summary\nText.\n## Key points\n- a\n')
    fs.writeFileSync(path.join(dir, 'output', 'transcript', '002.md'), '---\nheading: "Second"\nstart: 1:02:03\nend: 1:05:00\n---\nMore.\n')
    fs.writeFileSync(path.join(dir, 'output', 'transcript', '001.md'), '---\r\nheading: First\r\nstart: 0:05\r\nend: 2:10\r\n---\r\nHello.\r\n')
    const input = { fileName: 'a.mp3', startMs: 0, endMs: 4_000_000, language: 'en', topic: '', segments: [], transcriber: { model: 'large-v3', language: 'en' } }
    const result = await readOutput(dir, input)
    expect(result.title).toBe('Title here')
    expect(result.sections).toEqual([
      { heading: 'First', startMs: 5000, endMs: 130000, text: 'Hello.' },
      { heading: 'Second', startMs: 3723000, endMs: 3900000, text: 'More.' }
    ])
    expect(result.corrections).toBeUndefined()
    expect(validateResult(result, { startMs: 0, endMs: 4_000_000 }).ok).toBe(true)
  })

  it('builds a valid transcript-only fallback', () => {
    const segments = Array.from({ length: 50 }, (_, i) => ({ startMs: 60000 + i * 10000, endMs: 70000 + i * 10000, text: 'word '.repeat(30) }))
    const result = fallbackResult({ fileName: 'x'.repeat(100), startMs: 60000, endMs: 600000, language: 'en', topic: '', segments, transcriber: { model: 'm', language: 'en' } })
    expect(result.summaryFailed).toBe(true)
    expect(result.sections.length).toBeGreaterThan(1)
    expect(validateResult(result, { startMs: 60000, endMs: 600000 })).toEqual({ ok: true, result })
  })

  it('spots whisper repetition loops', () => {
    const seg = (text: string) => ({ startMs: 0, endMs: 1, text })
    expect(hasRepetitionLoop(['a', 'b', 'a', 'b'].map(seg))).toBe(false)
    expect(hasRepetitionLoop(Array.from({ length: 5 }, () => seg('same')))).toBe(false)
    expect(hasRepetitionLoop(Array.from({ length: 6 }, () => seg('same')))).toBe(true)
  })

  it('parses and formats timestamps', () => {
    expect(parseTimestamp('0:05')).toBe(5000)
    expect(parseTimestamp('12:34')).toBe(754000)
    expect(parseTimestamp('1:02:03')).toBe(3723000)
    expect(parseTimestamp('90.5')).toBe(90500)
    expect(parseTimestamp('1:60')).toBeUndefined()
    expect(parseTimestamp('soon')).toBeUndefined()
    expect(formatTimestamp(3723000)).toBe('1:02:03')
    expect(formatTimestamp(65000)).toBe('1:05')
  })

  it('can drop --restricted for an older Claude Code, and adds a model', () => {
    const base = loadConfig({ SERVER_URL: 'http://x', WORKER_TOKEN: 't', WHISPER_MODEL: '/m', CLAUDE_RESTRICTED: 'false', CLAUDE_MODEL: 'sonnet', CLAUDE_EXTRA_ARGS: '--effort high' })
    const args = claudeArgs(base, 'prompt')
    expect(args).not.toContain('--restricted')
    expect(args.slice(-4)).toEqual(['--model', 'sonnet', '--effort', 'high'])
  })
})

const hasFfmpeg = (() => { try { require('node:child_process').execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()

;(hasFfmpeg ? describe : describe.skip)('worker media steps with the real ffmpeg', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinopio-ffmpeg-'))
  const config = loadConfig({ SERVER_URL: 'http://x', WORKER_TOKEN: 't', WHISPER_MODEL: '/m' })
  const { execFileSync } = require('node:child_process')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { probe, cutAudio } = require('../worker/src/media')

  beforeAll(() => {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=20', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', path.join(dir, 'clip.mp4')])
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=3', '-c:v', 'libx264', path.join(dir, 'silent.mp4')])
  })

  it('probes audio and duration, and cuts the range to 16 kHz mono WAV', async () => {
    expect(await probe(config, path.join(dir, 'clip.mp4'))).toEqual({ hasAudio: true, durationMs: expect.any(Number) })
    expect((await probe(config, path.join(dir, 'silent.mp4'))).hasAudio).toBe(false)
    const wav = path.join(dir, 'cut.wav')
    await cutAudio(config, path.join(dir, 'clip.mp4'), wav, 5000, 12000)
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,codec_name:format=duration', '-of', 'json', wav]).toString())
    expect(info.streams[0]).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1 })
    expect(Number(info.format.duration)).toBeCloseTo(7, 0)
  })
})
