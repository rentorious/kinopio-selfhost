import { Body, Controller, HttpCode, Inject, Logger, Post, Req, Res, UseGuards } from '@nestjs/common'
import busboy from 'busboy'
import type { Request, Response } from 'express'
import { PassThrough } from 'node:stream'
import { AuthUser, CurrentUser, SignedInGuard } from '../common/auth'
import { ApiError, badRequest, unauthorized } from '../common/errors'
import { isValidId } from '../common/ids'
import { Config, CONFIG } from '../config'
import { DB, Db, JsonObject } from '../db/database'
import { SpacesService } from '../spaces/spaces.service'
import { origin } from '../stubs/stubs'
import { isValidKey } from './keys'
import { FILE_STORAGE, FileStorage } from './storage'
import { createUploadToken, UPLOAD_TOKEN_TTL_MS, verifyUploadToken } from './upload-token'

const MAX_FILES_PER_REQUEST = 100

/** Printable ASCII only: the type ends up in a Content-Type header. */
function contentType (type: unknown): string {
  return typeof type === 'string' && /^[\x20-\x7e]{1,255}$/.test(type) ? type : 'application/octet-stream'
}

/**
 * Uploads (SPEC.md §7). The client asks for a "presigned post", then sends a
 * multipart form (`fields` + `file`) to the url it got back, with no auth
 * header. Both halves are ours: the "presign" is a signed token, and the form
 * goes to POST /api/upload/direct, which streams the file into storage.
 */
@Controller()
export class UploadsController {
  private readonly log = new Logger('Uploads')

  constructor (
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Db,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    private readonly spaces: SpacesService
  ) {}

  @Post('upload/presigned-post')
  @HttpCode(200)
  @UseGuards(SignedInGuard)
  async presign (@CurrentUser() user: AuthUser, @Body() body: JsonObject, @Req() req: Request) {
    await this.checkSpace(user.id, body?.requestSpaceId)
    return this.presignOne(req, user.id, body?.key, body?.type)
  }

  @Post('upload/presigned-post/multiple')
  @HttpCode(200)
  @UseGuards(SignedInGuard)
  async presignMultiple (@CurrentUser() user: AuthUser, @Body() body: JsonObject, @Req() req: Request) {
    const files = body?.files
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_REQUEST) throw badRequest('files must be a non-empty array')
    await this.checkSpace(user.id, body?.requestSpaceId)
    for (const file of files as JsonObject[]) {
      if (typeof file?.size === 'number' && file.size > this.config.uploadMaxBytes) {
        throw new ApiError(413, `files can't be larger than ${Math.floor(this.config.uploadMaxBytes / 1024 / 1024)} MB`)
      }
    }
    return (files as JsonObject[]).map(file => this.presignOne(req, user.id, file?.key, file?.type))
  }

  /**
   * Ours, not in the client's API list. The client reports an upload as done
   * at 100% progress without checking the status, so bad requests are refused
   * as soon as possible and the rest of the body isn't read.
   */
  @Post('upload/direct')
  direct (@Req() req: Request, @Res() res: Response): void {
    let parser: busboy.Busboy
    try {
      parser = busboy({
        headers: req.headers,
        limits: { files: 1, fields: 20, fieldSize: 8192, fileSize: this.config.uploadMaxBytes }
      })
    } catch {
      res.status(400).json({ status: 400, message: 'expected a multipart form' })
      return
    }

    const fields: Record<string, string> = {}
    let sawFile = false
    let done = false
    let body: PassThrough | undefined

    const finish = (status: number, payload: JsonObject) => {
      if (done) return
      done = true
      req.unpipe(parser)
      if (res.writableEnded || res.destroyed) return
      if (status !== 200) {
        // stop the client sending the rest of a refused upload
        res.set('Connection', 'close')
        res.on('finish', () => req.destroy())
      }
      res.status(status).json(payload)
    }

    parser.on('field', (name, value) => { fields[name] = value })

    parser.on('file', (name, stream) => {
      if (name !== 'file' || sawFile || done) { stream.resume(); return }
      sawFile = true
      const claims = verifyUploadToken(fields.token, this.config.uploadSigningSecret)
      if (!claims || claims.key !== fields.key || !isValidKey(claims.key)) {
        stream.resume()
        finish(401, { status: 401, message: 'invalid or expired upload token' })
        return
      }
      let tooBig = false
      body = new PassThrough()
      // storage.put sees the error; this only stops an early one (before put
      // has attached its own listener) from crashing the process
      body.on('error', () => undefined)
      stream.on('limit', () => {
        tooBig = true
        body!.destroy(new Error('upload too large'))
      })
      stream.pipe(body)
      this.storage.put(claims.key, body, claims.type)
        .then(() => finish(200, {}))
        .catch(async err => {
          await this.storage.delete(claims.key).catch(() => undefined)
          if (tooBig) {
            finish(413, { status: 413, message: `files can't be larger than ${Math.floor(this.config.uploadMaxBytes / 1024 / 1024)} MB` })
          } else {
            if (!done) this.log.error(`upload of ${claims.key} failed: ${err instanceof Error ? err.message : String(err)}`)
            finish(500, { status: 500, message: 'upload failed' })
          }
        })
    })

    parser.on('close', () => {
      if (!sawFile) finish(400, { status: 400, message: 'no file in the form' })
    })
    parser.on('error', () => {
      body?.destroy(new Error('malformed upload'))
      finish(400, { status: 400, message: 'malformed upload' })
    })
    // the browser gave up (tab closed, network gone): drop what we have
    req.on('close', () => {
      if (!req.complete) body?.destroy(new Error('upload aborted'))
    })
    req.pipe(parser)
  }

  private presignOne (req: Request, userId: string, key: unknown, type: unknown) {
    if (!isValidKey(key)) throw badRequest('key must be <id>/<filename>')
    const token = createUploadToken({
      key,
      type: contentType(type),
      userId,
      maxBytes: this.config.uploadMaxBytes,
      exp: Date.now() + UPLOAD_TOKEN_TTL_MS
    }, this.config.uploadSigningSecret)
    return { url: `${origin(req)}/api/upload/direct`, fields: { key, token } }
  }

  private async checkSpace (userId: string, spaceId: unknown): Promise<void> {
    if (spaceId === undefined || spaceId === null || spaceId === '') return
    if (!isValidId(spaceId)) throw badRequest('invalid requestSpaceId')
    // 'notFound' is allowed: on a brand-new space the first upload can arrive
    // before the debounced createSpace op does.
    if (await this.spaces.canEdit(this.db, userId, spaceId) === 'forbidden') {
      throw unauthorized('you can only upload files to spaces you can edit')
    }
  }
}
