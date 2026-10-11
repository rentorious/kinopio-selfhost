import { CanActivate, Controller, Delete, ExecutionContext, Get, HttpCode, Inject, Injectable, Logger, Param, Post, Req, Res, UseGuards, Body } from '@nestjs/common'
import busboy from 'busboy'
import type { Request, Response } from 'express'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { AuthedRequest, AuthUser, CurrentUser, SignedInGuard } from '../common/auth'
import { ApiError, unauthorized } from '../common/errors'
import { isValidId } from '../common/ids'
import { Config, CONFIG } from '../config'
import { DB, Db } from '../db/database'
import { SpacesService } from '../spaces/spaces.service'
import { origin } from '../stubs/stubs'
import { MediaError, MediaService, NewJob } from './media.service'
import { bearer, sameSecret, WorkerHub } from './worker-hub'

function toApiError (err: unknown): unknown {
  if (err instanceof MediaError) return new ApiError(err.status, err.message, err.details ? { errors: err.details } : {})
  return err
}

const cleanName = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)

/** Validate the form fields that come before the file. Returns the job input or an error message. */
export function parseJobFields (fields: Record<string, string>, maxMinutes: number): Omit<NewJob, 'userId' | 'origin' | 'mimeType'> | string {
  const { spaceId, cardId, fileName, language = 'auto', topic = '' } = fields
  if (!isValidId(spaceId)) return 'spaceId is required'
  if (!isValidId(cardId)) return 'cardId is required'
  const name = cleanName(fileName ?? '')
  if (!name) return 'fileName is required'
  const startMs = Number(fields.startMs)
  const endMs = Number(fields.endMs)
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < 0 || endMs <= startMs) return 'startMs and endMs must be whole milliseconds with startMs < endMs'
  if (endMs - startMs > maxMinutes * 60_000) return `the selected part can be at most ${maxMinutes} minutes`
  if (!/^(auto|[a-z]{2,3})$/.test(language)) return 'language must be auto or a language code'
  if (topic.length > 500) return 'topic can be at most 500 characters'
  const num = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
  return { spaceId, cardId, fileName: name, startMs, endMs, language, topic: topic.trim(), cardX: num(fields.x), cardY: num(fields.y) }
}

/**
 * Client endpoints for media summaries (docs/MEDIA-SUMMARIES.md §10). Ours,
 * not part of the Kinopio client's API: Client Patch 4 calls them.
 */
@Controller('media-summaries')
export class MediaController {
  private readonly log = new Logger('Media')

  constructor (
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Db,
    private readonly media: MediaService,
    private readonly hub: WorkerHub,
    private readonly spaces: SpacesService
  ) {}

  @Get('status')
  @UseGuards(SignedInGuard)
  async status () {
    return await this.media.status()
  }

  /**
   * Start an upload straight to the bucket (when files are in one). JSON: the
   * same fields as the multipart form, plus mimeType and size. Returns a
   * signed PUT link that works for an hour; the browser sends the file there
   * with that Content-Type, then calls POST :id/uploaded. Requests through
   * Railway's proxy must finish their body within 5 minutes, which a long
   * video on a home connection doesn't.
   */
  @Post('direct')
  @HttpCode(200)
  @UseGuards(SignedInGuard)
  async direct (@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>, @Req() req: Request) {
    if (!this.media.enabled || !this.hub.online) throw new ApiError(503, 'the transcriber is offline', { error: 'transcriber_offline' })
    if (!this.media.bucket) throw new ApiError(404, 'direct uploads need the bucket', { error: 'direct_unsupported' })
    const fields: Record<string, string> = {}
    for (const [k, v] of Object.entries(body ?? {})) if (typeof v === 'string' || typeof v === 'number') fields[k] = String(v)
    const size = Number(fields.size)
    if (!Number.isInteger(size) || size <= 0) throw new ApiError(400, 'size is required')
    if (size > this.config.media.maxBytes) throw new ApiError(413, `files can't be larger than ${Math.floor(this.config.media.maxBytes / 1024 / 1024)} MB`)
    const mimeType = /^(audio|video)\/[\w.+-]{1,100}$/.test(fields.mimeType ?? '') ? fields.mimeType : ''
    if (!mimeType) throw new ApiError(415, 'only audio and video files can be summarized')
    const parsed = parseJobFields(fields, this.config.media.maxMinutes)
    if (typeof parsed === 'string') throw new ApiError(400, parsed)
    if (await this.spaces.canEdit(this.db, user.id, parsed.spaceId) === 'forbidden') throw unauthorized('you can only summarize into spaces you can edit')
    const job = await this.media.createJob({ ...parsed, userId: user.id, origin: origin(req), mimeType })
    try {
      return { jobId: job.id, url: await this.media.directUploadUrl(job), method: 'PUT', headers: { 'Content-Type': mimeType } }
    } catch (err) {
      await this.media.uploadFailed(job.id, 'could not start the upload')
      throw err
    }
  }

  @Post(':id/uploaded')
  @HttpCode(202)
  @UseGuards(SignedInGuard)
  async uploaded (@CurrentUser() user: AuthUser, @Param('id') id: string) {
    try {
      await this.media.directUploadDone(id, user.id)
      return { jobId: id }
    } catch (err) { throw toApiError(err) }
  }

  /**
   * Multipart: spaceId, cardId, fileName, startMs, endMs, language, topic,
   * x, y, then the file. Everything is checked before the file is read, and
   * the file only ever goes to MEDIA_TMP_DIR.
   */
  @Post()
  @UseGuards(SignedInGuard)
  upload (@CurrentUser() user: AuthUser, @Req() req: Request, @Res() res: Response): void {
    let done = false
    let jobId: string | undefined
    const tooBig = `files can't be larger than ${Math.floor(this.config.media.maxBytes / 1024 / 1024)} MB`
    const reply = (status: number, payload: Record<string, unknown>) => {
      if (done) return
      done = true
      req.unpipe(parser)
      if (res.writableEnded || res.destroyed) return
      if (status >= 400) {
        res.set('Connection', 'close')
        res.on('finish', () => req.destroy())
      }
      res.status(status).json(payload)
    }

    if (!this.media.enabled || !this.hub.online) {
      res.status(503).json({ status: 503, error: 'transcriber_offline', message: 'the transcriber is offline' })
      return
    }
    const declared = Number(req.headers['content-length'])
    if (declared > this.config.media.maxBytes + 64 * 1024) {
      res.status(413).set('Connection', 'close').json({ status: 413, message: tooBig })
      return
    }

    let parser: busboy.Busboy
    try {
      parser = busboy({ headers: req.headers, limits: { files: 1, fields: 20, fieldSize: 4096, fileSize: this.config.media.maxBytes } })
    } catch {
      res.status(400).json({ status: 400, message: 'expected a multipart form' })
      return
    }

    const fields: Record<string, string> = {}
    let sawFile = false
    parser.on('field', (name, value) => { fields[name] = value })
    parser.on('file', (name, stream, info) => {
      if (name !== 'file' || sawFile || done) { stream.resume(); return }
      sawFile = true
      stream.pause()
      void this.receive(user, req, fields, stream, info.mimeType, tooBig, reply, id => { jobId = id })
    })
    parser.on('close', () => { if (!sawFile) reply(400, { status: 400, message: 'no file in the form' }) })
    parser.on('error', () => reply(400, { status: 400, message: 'malformed upload' }))
    req.on('close', () => {
      if (!req.complete && jobId) void this.media.uploadFailed(jobId, 'the upload was interrupted')
    })
    req.pipe(parser)
  }

  private async receive (
    user: AuthUser, req: Request, fields: Record<string, string>, stream: NodeJS.ReadableStream & { truncated?: boolean },
    mimeType: string, tooBig: string,
    reply: (status: number, payload: Record<string, unknown>) => void,
    setJobId: (id: string) => void
  ): Promise<void> {
    const parsed = parseJobFields(fields, this.config.media.maxMinutes)
    if (typeof parsed === 'string') { stream.resume(); return reply(400, { status: 400, message: parsed }) }
    if (mimeType && !/^(audio|video)\//.test(mimeType) && mimeType !== 'application/octet-stream') {
      stream.resume()
      return reply(415, { status: 415, message: 'only audio and video files can be summarized' })
    }
    try {
      if (await this.spaces.canEdit(this.db, user.id, parsed.spaceId) === 'forbidden') throw unauthorized('you can only summarize into spaces you can edit')
    } catch (err) {
      stream.resume()
      return reply(401, { status: 401, message: err instanceof Error ? err.message : 'not allowed' })
    }

    const job = await this.media.createJob({ ...parsed, userId: user.id, origin: origin(req), mimeType: mimeType || 'application/octet-stream' })
    setJobId(job.id)
    let limited = false
    stream.on('limit', () => { limited = true })
    try {
      await pipeline(stream, fs.createWriteStream(this.media.tmpPath(job.id)))
      // busboy may have hit the limit before the listener above was attached
      limited ||= stream.truncated === true
      if (limited) throw new Error('too big')
      const { size } = await fs.promises.stat(this.media.tmpPath(job.id))
      reply(202, { jobId: job.id })
      await this.media.uploadDone(job.id, size)
    } catch (err) {
      await this.media.uploadFailed(job.id, limited ? 'the file is too large' : 'the upload failed')
      if (!limited) this.log.warn(`upload for job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`)
      reply(limited ? 413 : 500, { status: limited ? 413 : 500, message: limited ? tooBig : 'upload failed' })
    }
  }

  @Get(':id')
  @UseGuards(SignedInGuard)
  async get (@CurrentUser() user: AuthUser, @Param('id') id: string) {
    try {
      const job = await this.media.jobForUser(id, user.id)
      return { id: job.id, status: job.status, percent: job.percent, error: job.error, transcriptSpaceId: job.transcriptSpaceId }
    } catch (err) { throw toApiError(err) }
  }

  @Delete(':id')
  @HttpCode(200)
  @UseGuards(SignedInGuard)
  async cancel (@CurrentUser() user: AuthUser, @Param('id') id: string) {
    try {
      await this.media.cancel(id, user.id)
      return {}
    } catch (err) { throw toApiError(err) }
  }
}

@Injectable()
export class WorkerGuard implements CanActivate {
  constructor (@Inject(CONFIG) private readonly config: Config) {}
  canActivate (ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>()
    if (!sameSecret(bearer(req.header('authorization')), this.config.media.workerToken)) throw unauthorized('worker token required')
    return true
  }
}

/** The PC worker's HTTP side (docs/MEDIA-SUMMARIES.md §5): the file down, the result up. */
@Controller('worker/jobs')
@UseGuards(WorkerGuard)
export class WorkerController {
  constructor (private readonly media: MediaService) {}

  @Get(':id/media')
  async download (@Param('id') id: string, @Res() res: Response): Promise<void> {
    try {
      const job = await this.media.jobForWorker(id)
      // in the bucket: send the worker there (fetch drops our Authorization header on the way)
      const url = await this.media.workerDownloadUrl(job)
      if (url) { res.redirect(302, url); return }
      const file = this.media.tmpPath(job.id)
      const { size } = await fs.promises.stat(file)
      res.status(200).set({ 'Content-Type': job.mimeType, 'Content-Length': String(size), 'Cache-Control': 'no-store' })
      await pipeline(fs.createReadStream(file), res)
    } catch (err) {
      if (res.headersSent) { res.destroy(); return }
      const status = err instanceof MediaError ? err.status : 404
      res.status(status).json({ status, message: 'file not available' })
    }
  }

  @Post(':id/result')
  @HttpCode(200)
  async result (@Param('id') id: string, @Body() body: unknown) {
    try {
      await this.media.submitResult(id, body)
      return {}
    } catch (err) { throw toApiError(err) }
  }
}
