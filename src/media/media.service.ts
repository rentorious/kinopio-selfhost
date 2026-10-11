import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from '../common/ids'
import { Config, CONFIG } from '../config'
import { DB, Db, MediaJobStatus } from '../db/database'
import { DirectStorage, FILE_STORAGE, FileStorage, isDirectStorage } from '../files/storage'
import { OperationsService } from '../operations/operations.service'
import { Relay } from '../realtime/relay'
import { spaceUrl } from '../spaces/space-data'
import { CardEvents } from './card-events'
import { JobOffer, MediaResult, validateResult, WorkerMessage } from './contract'
import { stageText, summaryCardText, transcriptCards } from './texts'
import { WorkerHub } from './worker-hub'

export interface Job {
  id: string
  userId: string
  spaceId: string
  cardId: string
  cardX: number | null
  cardY: number | null
  origin: string
  fileName: string
  mimeType: string
  bytes: number | null
  startMs: number
  endMs: number
  language: string
  topic: string
  status: MediaJobStatus
  percent: number | null
  error: string | null
  transcriptSpaceId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface NewJob {
  userId: string
  spaceId: string
  cardId: string
  cardX: number | null
  cardY: number | null
  origin: string
  fileName: string
  mimeType: string
  startMs: number
  endMs: number
  language: string
  topic: string
}

const FINAL: MediaJobStatus[] = ['done', 'failed', 'canceled']
const WITH_WORKER: MediaJobStatus[] = ['downloading', 'transcribing', 'summarizing']
const SWEEP_MS = 10 * 60 * 1000
const SUMMARY_CARD_WIDTH = 360
/**
 * Media in the bucket lives under this prefix. The leading dot keeps it out of
 * GET /files/* (keys.ts only accepts `<id>/<filename>`).
 */
const MEDIA_PREFIX = '.media/'
/** How long the browser's signed upload link works. */
export const DIRECT_UPLOAD_TTL_S = 60 * 60
/** How long the worker's signed download link works. */
const DIRECT_DOWNLOAD_TTL_S = 30 * 60

export class MediaError extends Error {
  constructor (readonly status: number, message: string, readonly details?: string[]) { super(message) }
}

/**
 * Media summary jobs (docs/MEDIA-SUMMARIES.md): the queue, the conversation
 * with the PC worker, the temp file that is the only copy of the media, and
 * building the summary card and transcript space when a result comes back.
 *
 * State changes run one at a time (`serial`), so worker messages, uploads,
 * cancels and sweeps never interleave.
 */
@Injectable()
export class MediaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Media')
  private chain: Promise<unknown> = Promise.resolve()
  /** The job the worker currently has. One GPU, one job. */
  private activeJobId?: string
  private graceTimer?: NodeJS.Timeout
  private sweepTimer?: NodeJS.Timeout
  private readonly timers = new Set<NodeJS.Timeout>()

  constructor (
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Db,
    private readonly ops: OperationsService,
    private readonly relay: Relay,
    private readonly hub: WorkerHub,
    private readonly cardEvents: CardEvents,
    @Inject(FILE_STORAGE) storage: FileStorage
  ) {
    this.bucket = isDirectStorage(storage) ? storage : undefined
  }

  /**
   * Set when files go to the bucket: the browser then uploads media straight
   * to it with a signed link (Railway's proxy cuts request bodies off after
   * 5 minutes), and the worker downloads it the same way.
   */
  readonly bucket?: DirectStorage

  async onModuleInit (): Promise<void> {
    await fs.promises.mkdir(this.config.media.tmpDir, { recursive: true })
    this.hub.on('message', (msg: WorkerMessage) => { void this.serial(() => this.onWorkerMessage(msg)) })
    this.hub.on('disconnected', () => { void this.serial(async () => this.onWorkerGone()) })
    this.cardEvents.on('cardRemoved', (spaceId: string, cardId: string) => {
      void this.serial(() => this.onCardRemoved(spaceId, cardId))
    })
    await this.serial(() => this.recoverAfterRestart())
    this.sweepTimer = setInterval(() => { void this.serial(() => this.sweep()) }, SWEEP_MS)
    this.sweepTimer.unref()
  }

  onModuleDestroy (): void {
    clearInterval(this.sweepTimer)
    clearTimeout(this.graceTimer)
    for (const t of this.timers) clearTimeout(t)
  }

  /** Wait for queued state changes (tests). */
  async idle (): Promise<void> { await this.chain }

  get enabled (): boolean { return !!this.config.media.workerToken }

  tmpPath (jobId: string): string {
    return path.join(this.config.media.tmpDir, jobId)
  }

  bucketKey (jobId: string): string {
    return `${MEDIA_PREFIX}${jobId}`
  }

  /** A signed link the browser PUTs the file to. */
  async directUploadUrl (job: Job): Promise<string> {
    if (!this.bucket) throw new MediaError(404, 'direct uploads need the bucket')
    return await this.bucket.presignPut(this.bucketKey(job.id), job.mimeType, DIRECT_UPLOAD_TTL_S)
  }

  /** The browser says its direct upload finished: check the file is there and queue the job. */
  async directUploadDone (jobId: string, userId: string): Promise<void> {
    const job = await this.jobForUser(jobId, userId)
    if (!this.bucket) throw new MediaError(404, 'direct uploads need the bucket')
    if (job.status !== 'uploading') throw new MediaError(409, `the job is ${job.status}`)
    const info = await this.bucket.head(this.bucketKey(jobId))
    if (!info) throw new MediaError(400, 'the file has not arrived')
    if (info.size > this.config.media.maxBytes) {
      await this.uploadFailed(jobId, 'the file is too large')
      throw new MediaError(413, `files can't be larger than ${Math.floor(this.config.media.maxBytes / 1024 / 1024)} MB`)
    }
    await this.uploadDone(jobId, info.size)
  }

  /** Where the worker gets the file: a signed bucket link, or undefined for the temp disk. */
  async workerDownloadUrl (job: Job): Promise<string | undefined> {
    if (!this.bucket || !await this.bucket.head(this.bucketKey(job.id))) return undefined
    return await this.bucket.presignGet(this.bucketKey(job.id), DIRECT_DOWNLOAD_TTL_S)
  }

  // --- client side ---

  async status (): Promise<{ online: boolean, lastSeenAt: string | null, busy: boolean, queued: number, model: string | null }> {
    const queued = await this.db.selectFrom('media_jobs').select(eb => eb.fn.countAll<string>().as('n')).where('status', '=', 'queued').executeTakeFirst()
    return {
      online: this.enabled && this.hub.online,
      lastSeenAt: this.hub.lastSeenAt?.toISOString() ?? null,
      busy: !!this.activeJobId,
      queued: Number(queued?.n ?? 0),
      model: this.hub.workerInfo?.model || null
    }
  }

  async createJob (input: NewJob): Promise<Job> {
    const id = nanoid()
    await this.db.insertInto('media_jobs').values({
      id,
      user_id: input.userId,
      space_id: input.spaceId,
      card_id: input.cardId,
      card_x: input.cardX,
      card_y: input.cardY,
      origin: input.origin,
      file_name: input.fileName,
      mime_type: input.mimeType,
      start_ms: input.startMs,
      end_ms: input.endMs,
      language: input.language,
      topic: input.topic,
      status: 'uploading'
    }).execute()
    return (await this.job(id))!
  }

  uploadDone (jobId: string, bytes: number): Promise<void> {
    return this.serial(async () => {
      const job = await this.job(jobId)
      if (!job || job.status !== 'uploading') { await this.deleteTmp(jobId); return }
      await this.db.updateTable('media_jobs').set({ bytes }).where('id', '=', jobId).execute()
      await this.setStage(job, 'queued')
      await this.dispatch()
    })
  }

  uploadFailed (jobId: string, reason: string): Promise<void> {
    return this.serial(async () => {
      const job = await this.job(jobId)
      if (job && !FINAL.includes(job.status)) await this.finish(job, 'failed', reason)
      await this.deleteTmp(jobId)
    })
  }

  async jobForUser (jobId: string, userId: string): Promise<Job> {
    const job = await this.job(jobId)
    if (!job || job.userId !== userId) throw new MediaError(404, 'job not found')
    return job
  }

  cancel (jobId: string, userId: string): Promise<void> {
    return this.serial(async () => {
      const job = await this.jobForUser(jobId, userId)
      if (FINAL.includes(job.status)) return
      await this.finish(job, 'canceled')
    })
  }

  // --- worker side ---

  /** The job the worker may download from, if it's this one. */
  async jobForWorker (jobId: string): Promise<Job> {
    const job = await this.job(jobId)
    if (!job || jobId !== this.activeJobId || !WITH_WORKER.includes(job.status)) throw new MediaError(404, 'no such job for the worker')
    return job
  }

  submitResult (jobId: string, body: unknown): Promise<void> {
    return this.serial(async () => {
      const job = await this.jobForWorker(jobId)
      const checked = validateResult(body, { startMs: job.startMs, endMs: job.endMs })
      if (!checked.ok) {
        await this.finish(job, 'failed', 'the transcriber sent an invalid result')
        throw new MediaError(422, 'invalid result', checked.errors)
      }
      this.activeJobId = undefined
      await this.setStage(job, 'building')
      try {
        await this.build(job, checked.result)
      } catch (err) {
        this.log.error(`building job ${job.id} failed: ${err instanceof Error ? err.stack : String(err)}`)
        await this.finish(job, 'failed', 'could not create the transcript')
      }
      await this.dispatch()
    })
  }

  private async onWorkerMessage (msg: WorkerMessage): Promise<void> {
    if (msg.type === 'hello') {
      const active = this.activeJobId
      if (active && msg.activeJobId === active) {
        clearTimeout(this.graceTimer)
        this.graceTimer = undefined
        return
      }
      if (active) {
        // reconnected without our job: it was lost (worker restarted)
        const job = await this.job(active)
        if (job && !FINAL.includes(job.status)) await this.finish(job, 'failed', 'the transcriber restarted')
      }
      if (msg.activeJobId && msg.activeJobId !== active) this.hub.send({ type: 'cancel', jobId: msg.activeJobId })
      await this.dispatch()
      return
    }
    if (!('jobId' in msg) || msg.jobId !== this.activeJobId) {
      if ('jobId' in msg && msg.type !== 'failed') this.hub.send({ type: 'cancel', jobId: msg.jobId })
      return
    }
    const job = await this.job(msg.jobId)
    if (!job || FINAL.includes(job.status)) return
    if (msg.type === 'downloaded') {
      await this.deleteTmp(job.id)
      await this.setStage(job, 'transcribing', 0)
    } else if (msg.type === 'progress') {
      const stage = msg.stage === 'summarizing' ? 'summarizing' : 'transcribing'
      const percent = typeof msg.percent === 'number' ? Math.max(0, Math.min(100, Math.round(msg.percent))) : null
      if (stage !== job.status || percent !== job.percent) await this.setStage(job, stage, percent)
    } else if (msg.type === 'failed') {
      await this.finish(job, 'failed', String(msg.reason || 'transcription failed').slice(0, 200))
      await this.dispatch()
    }
  }

  private onWorkerGone (): void {
    if (!this.activeJobId || this.graceTimer) return
    const jobId = this.activeJobId
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined
      void this.serial(async () => {
        if (this.activeJobId !== jobId) return
        const job = await this.job(jobId)
        if (job && !FINAL.includes(job.status)) await this.finish(job, 'failed', 'the transcriber went offline')
      })
    }, this.config.media.offlineGraceMs)
    this.graceTimer.unref()
  }

  private async onCardRemoved (spaceId: string, cardId: string): Promise<void> {
    const jobs = await this.db.selectFrom('media_jobs').select('id')
      .where('card_id', '=', cardId).where('space_id', '=', spaceId)
      .where('status', 'not in', FINAL)
      .execute()
    for (const { id } of jobs) {
      const job = await this.job(id)
      if (job) await this.finish(job, 'canceled', null, { updateCard: false })
    }
    if (jobs.length) await this.dispatch()
  }

  // --- queue ---

  private async dispatch (): Promise<void> {
    if (this.activeJobId || !this.enabled || !this.hub.online) return
    const next = await this.db.selectFrom('media_jobs').select('id')
      .where('status', '=', 'queued').orderBy('created_at', 'asc').limit(1)
      .executeTakeFirst()
    if (!next) return
    const job = (await this.job(next.id))!
    const offer: JobOffer = {
      jobId: job.id,
      fileName: job.fileName,
      mimeType: job.mimeType,
      bytes: job.bytes ?? 0,
      startMs: job.startMs,
      endMs: job.endMs,
      language: job.language,
      topic: job.topic,
      mediaPath: `/api/worker/jobs/${job.id}/media`,
      resultPath: `/api/worker/jobs/${job.id}/result`
    }
    if (!this.hub.send({ type: 'job', job: offer })) return
    this.activeJobId = job.id
    await this.setStage(job, 'downloading')
  }

  /** End a job: record it, drop its file, free the worker, and say so on the card. */
  private async finish (job: Job, status: 'failed' | 'canceled', error?: string | null, opts: { updateCard?: boolean } = {}): Promise<void> {
    if (this.activeJobId === job.id) {
      this.activeJobId = undefined
      clearTimeout(this.graceTimer)
      this.graceTimer = undefined
      if (status === 'canceled' || this.hub.online) this.hub.send({ type: 'cancel', jobId: job.id })
    }
    await this.deleteTmp(job.id)
    await this.db.updateTable('media_jobs')
      .set({ status, error: error ?? null, updated_at: new Date() })
      .where('id', '=', job.id).execute()
    if (status === 'failed') this.log.warn(`job ${job.id} (${job.fileName}) failed: ${error}`)
    if (opts.updateCard !== false) await this.setCardName(job, stageText(job.fileName, status, null, error))
  }

  private async setStage (job: Job, status: MediaJobStatus, percent: number | null = null): Promise<void> {
    await this.db.updateTable('media_jobs')
      .set({ status, percent, updated_at: new Date() })
      .where('id', '=', job.id).execute()
    job.status = status
    job.percent = percent
    await this.setCardName(job, stageText(job.fileName, status, percent))
  }

  // --- building the result ---

  private async build (job: Job, result: MediaResult): Promise<void> {
    const origin = job.origin.replace(/\/$/, '')
    const space = await this.db.selectFrom('spaces').select('name').where('id', '=', job.spaceId).executeTakeFirst()
    const backLink = `${origin}/${spaceUrl(space?.name ?? '', job.spaceId)}`
    const info = { fileName: job.fileName, startMs: job.startMs, endMs: job.endMs, language: result.transcriber.language || job.language }

    const transcriptId = nanoid()
    const transcriptName = `Transcript: ${result.title.trim()}`
    const cards = transcriptCards(result, info, backLink)
    const created = await this.ops.apply(job.userId, [{
      name: 'createSpace',
      body: { id: transcriptId, name: transcriptName, privacy: 'private', cards, spaceId: transcriptId, operationId: nanoid() }
    }])
    if (created.errors.length) throw new Error(`createSpace: ${created.errors.map(e => e.message).join(', ')}`)

    const transcriptUrl = `${origin}/${spaceUrl(transcriptName, transcriptId)}`
    await this.db.updateTable('media_jobs')
      .set({ status: 'done', percent: null, transcript_space_id: transcriptId, updated_at: new Date() })
      .where('id', '=', job.id).execute()
    // wider than a normal card, so the abstract reads comfortably
    await this.setCardName(job, summaryCardText(result, info, transcriptUrl), { final: true, extra: { resizeWidth: SUMMARY_CARD_WIDTH } })
    this.log.log(`job ${job.id} done: ${result.sections.length} sections in space ${transcriptId}`)
  }

  /**
   * Save a card's text through the normal write path (so merge rules and the
   * space's timestamps behave as if the user typed it) and push it to every
   * open tab on that space.
   */
  private async setCardName (job: Job, name: string, opts: { final?: boolean, extra?: Record<string, unknown> } = {}): Promise<void> {
    const nameUpdatedAt = new Date().toISOString()
    const extra = opts.extra ?? {}
    this.relay.broadcast(job.spaceId, {
      message: { action: 'updateCardsState', store: 'cardStore', updates: [{ id: job.cardId, name, nameUpdatedAt, ...extra }] }
    })
    const saved = await this.updateCard(job, name, nameUpdatedAt, extra)
    if (saved || !opts.final) return
    // The placeholder card hasn't reached the server yet (the client batches
    // its writes). Try again for a while, then create it where it was dropped.
    let attempt = 0
    const retry = () => {
      const t = setTimeout(() => {
        this.timers.delete(t)
        void this.serial(async () => {
          if (await this.updateCard(job, name, nameUpdatedAt, extra)) return
          if (++attempt < 10) return retry()
          await this.ops.apply(job.userId, [{
            name: 'createCard',
            body: { id: job.cardId, x: job.cardX ?? 100, y: job.cardY ?? 100, z: 1, name, nameUpdatedAt, ...extra, spaceId: job.spaceId, operationId: nanoid() }
          }])
        })
      }, 3000)
      t.unref()
      this.timers.add(t)
    }
    retry()
  }

  private async updateCard (job: Job, name: string, nameUpdatedAt: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    const res = await this.ops.apply(job.userId, [{
      name: 'updateCard',
      body: { id: job.cardId, name, nameUpdatedAt, ...extra, spaceId: job.spaceId, operationId: nanoid() }
    }])
    return res.errors.length === 0
  }

  // --- housekeeping ---

  private async recoverAfterRestart (): Promise<void> {
    const stuck = await this.db.selectFrom('media_jobs').select('id').where('status', 'not in', FINAL).execute()
    for (const { id } of stuck) {
      const job = await this.job(id)
      if (job) await this.finish(job, 'failed', 'the server restarted')
    }
    for (const name of await fs.promises.readdir(this.config.media.tmpDir)) {
      await fs.promises.rm(path.join(this.config.media.tmpDir, name), { force: true, recursive: true })
    }
    await this.sweepBucket(new Set())
  }

  /** Fail jobs whose file waited too long, and delete any file no live job owns. */
  async sweep (now = Date.now()): Promise<void> {
    const cutoff = new Date(now - this.config.media.tmpMaxAgeMs)
    const stale = await this.db.selectFrom('media_jobs').select('id')
      .where('status', 'in', ['uploading', 'queued', 'downloading'])
      .where('created_at', '<', cutoff)
      .execute()
    for (const { id } of stale) {
      const job = await this.job(id)
      if (job) await this.finish(job, 'failed', 'waited too long for the transcriber')
    }
    const live = new Set((await this.db.selectFrom('media_jobs').select('id')
      .where('status', 'in', ['uploading', 'queued', 'downloading']).execute()).map(r => r.id))
    for (const name of await fs.promises.readdir(this.config.media.tmpDir)) {
      if (!live.has(name)) await fs.promises.rm(path.join(this.config.media.tmpDir, name), { force: true, recursive: true })
    }
    await this.sweepBucket(live)
    if (stale.length) await this.dispatch()
  }

  /** Delete media in the bucket that no live job owns (e.g. an upload that finished after a cancel). */
  private async sweepBucket (live: Set<string>): Promise<void> {
    if (!this.bucket) return
    try {
      for (const key of await this.bucket.list(MEDIA_PREFIX)) {
        if (!live.has(key.slice(MEDIA_PREFIX.length))) await this.bucket.delete(key)
      }
    } catch (err) {
      this.log.warn(`could not sweep media in the bucket: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async deleteTmp (jobId: string): Promise<void> {
    await fs.promises.rm(this.tmpPath(jobId), { force: true })
    if (!this.bucket) return
    // the worker may already have it; a failed delete is retried by the sweep
    await this.bucket.delete(this.bucketKey(jobId)).catch(err => {
      this.log.warn(`could not delete media for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private async job (id: string): Promise<Job | undefined> {
    const r = await this.db.selectFrom('media_jobs').selectAll().where('id', '=', id).executeTakeFirst()
    if (!r) return undefined
    return {
      id: r.id,
      userId: r.user_id,
      spaceId: r.space_id,
      cardId: r.card_id,
      cardX: r.card_x,
      cardY: r.card_y,
      origin: r.origin,
      fileName: r.file_name,
      mimeType: r.mime_type,
      bytes: r.bytes === null ? null : Number(r.bytes),
      startMs: Number(r.start_ms),
      endMs: Number(r.end_ms),
      language: r.language,
      topic: r.topic,
      status: r.status,
      percent: r.percent,
      error: r.error,
      transcriptSpaceId: r.transcript_space_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }

  private serial<T> (fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.catch(err => {
      if (!(err instanceof MediaError)) this.log.error(err instanceof Error ? err.stack : String(err))
    })
    return run
  }
}
