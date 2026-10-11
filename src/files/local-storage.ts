import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ByteRange, FileInfo, FileStorage } from './storage'

/**
 * Files on disk, for local development (FILES_DRIVER=local). Each file's
 * content type is kept in `.meta/<key>.json`; ids can't start with a dot, so
 * no key collides with `.meta` or `.tmp`.
 */
export class LocalStorage implements FileStorage {
  constructor (private readonly dir: string) {}

  private file (key: string): string { return path.join(this.dir, key) }
  private meta (key: string): string { return path.join(this.dir, '.meta', `${key}.json`) }

  async put (key: string, body: Readable, contentType: string): Promise<void> {
    const tmpDir = path.join(this.dir, '.tmp')
    await fs.promises.mkdir(tmpDir, { recursive: true })
    const tmp = path.join(tmpDir, randomBytes(12).toString('hex'))
    try {
      await pipeline(body, fs.createWriteStream(tmp))
      await fs.promises.mkdir(path.dirname(this.file(key)), { recursive: true })
      await fs.promises.mkdir(path.dirname(this.meta(key)), { recursive: true })
      await fs.promises.writeFile(this.meta(key), JSON.stringify({ contentType }))
      await fs.promises.rename(tmp, this.file(key))
    } catch (err) {
      await fs.promises.rm(tmp, { force: true })
      throw err
    }
  }

  async head (key: string): Promise<FileInfo | undefined> {
    try {
      const stat = await fs.promises.stat(this.file(key))
      if (!stat.isFile()) return undefined
      let contentType = 'application/octet-stream'
      try {
        contentType = JSON.parse(await fs.promises.readFile(this.meta(key), 'utf8')).contentType || contentType
      } catch { /* no meta: serve as binary */ }
      return { size: stat.size, contentType }
    } catch {
      return undefined
    }
  }

  async get (key: string, range?: ByteRange): Promise<Readable> {
    return fs.createReadStream(this.file(key), range ? { start: range.start, end: range.end } : undefined)
  }

  async delete (key: string): Promise<void> {
    await fs.promises.rm(this.file(key), { force: true })
    await fs.promises.rm(this.meta(key), { force: true })
  }
}
