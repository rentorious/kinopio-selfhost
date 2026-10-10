import fs from 'node:fs'
import path from 'node:path'
import express, { NextFunction, Request, Response } from 'express'

/** Files that must be revalidated on every load so a new deploy (and service worker) is picked up. */
const ALWAYS_REVALIDATE = /(\.html|\/sw\.js|\/registerSW\.js|\.webmanifest)$/

function cacheHeaders (res: Response, filePath: string): void {
  if (ALWAYS_REVALIDATE.test(filePath)) {
    res.setHeader('Cache-Control', 'no-cache')
  } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    // Vite's hashed bundles: the name changes whenever the content does
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600')
  }
}

/**
 * Serve the built Kinopio client. Mirrors the Netlify rules in the client's
 * dist/_redirects: real files first, then pre-rendered `<path>.html`, then the
 * SPA shell `app.html`. /api and /files are left to the server.
 */
export function clientStatic (dist: string) {
  const hasClient = fs.existsSync(path.join(dist, 'app.html'))
  const serveFiles = express.static(dist, { index: 'index.html', fallthrough: true, setHeaders: cacheHeaders })

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path.startsWith('/files/')) return next()
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (!hasClient) {
      res.status(503).type('text/plain').send('Client not built. Run `npm run client:build` or use the Docker image.')
      return
    }
    serveFiles(req, res, () => {
      const clean = path.normalize(decodeURIComponent(req.path)).replace(/^(\.\.[/\\])+/, '').replace(/\/+$/, '')
      const page = path.join(dist, `${clean}.html`)
      res.setHeader('Cache-Control', 'no-cache')
      if (clean && page.startsWith(dist) && fs.existsSync(page)) {
        res.sendFile(page)
        return
      }
      res.sendFile(path.join(dist, 'app.html'))
    })
  }
}
