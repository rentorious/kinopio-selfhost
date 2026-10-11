import express, { Request, Response, Router } from 'express'
import { pipeline } from 'node:stream/promises'
import { isValidKey } from './keys'
import type { ByteRange, FileStorage } from './storage'

/**
 * Parse a single-range `Range: bytes=…` header. Returns undefined to serve the
 * whole file (no header, multiple ranges, or garbage), 'unsatisfiable' for a
 * range that starts past the end.
 */
export function parseRange (header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined {
  if (!header) return undefined
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return undefined
  if (size === 0) return 'unsatisfiable'
  if (m[1] === '') {
    // suffix: the last N bytes
    const n = Number(m[2])
    if (n === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (start >= size) return 'unsatisfiable'
  if (end < start) return undefined
  return { start, end }
}

/** Types a browser would run as a page: served sandboxed so they can't reach the app's storage. */
function isActiveContent (type: string): boolean {
  return /html|xml|svg|javascript|ecmascript/i.test(type)
}

const notFound = { status: 404, message: 'file not found' }

/**
 * GET /files/<id>/<filename> (SPEC.md §7). The patched client's `cdnHost` is
 * `<origin>/files` and it builds file URLs itself. Keys are never reused for
 * different content, so responses are cached forever. Range requests let
 * audio and video seek.
 */
export function filesRouter (storage: FileStorage): Router {
  const router = express.Router()
  router.get('/:id/:name', async (req: Request, res: Response) => {
    const key = `${String(req.params.id)}/${String(req.params.name)}`
    if (!isValidKey(key)) { res.status(404).json(notFound); return }
    try {
      const info = await storage.head(key)
      if (!info) { res.status(404).json(notFound); return }
      const range = parseRange(req.headers.range, info.size)
      res.set({
        'Content-Type': info.contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      })
      if (isActiveContent(info.contentType)) {
        res.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
      }
      if (range === 'unsatisfiable') {
        res.status(416).set('Content-Range', `bytes */${info.size}`).end()
        return
      }
      if (range) {
        res.status(206).set({
          'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
          'Content-Length': String(range.end - range.start + 1)
        })
      } else {
        res.status(200).set('Content-Length', String(info.size))
      }
      if (req.method === 'HEAD') { res.end(); return }
      await pipeline(await storage.get(key, range), res)
    } catch {
      // a viewer closing a video mid-stream lands here too
      if (!res.headersSent) res.status(500).json({ status: 500, message: 'could not read file' })
      else res.destroy()
    }
  })
  router.use((_req: Request, res: Response) => { res.status(404).json(notFound) })
  return router
}
