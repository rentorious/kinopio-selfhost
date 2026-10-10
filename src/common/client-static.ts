import fs from 'node:fs'
import path from 'node:path'
import express, { NextFunction, Request, Response } from 'express'

/**
 * Serve the built Kinopio client. Mirrors the Netlify rules in the client's
 * dist/_redirects: real files first, then pre-rendered `<path>.html`, then the
 * SPA shell `app.html`. /api and /files are left to the server.
 */
export function clientStatic (dist: string) {
  const hasClient = fs.existsSync(path.join(dist, 'app.html'))
  const serveFiles = express.static(dist, { index: 'index.html', fallthrough: true, maxAge: '1h' })

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
      if (clean && page.startsWith(dist) && fs.existsSync(page)) {
        res.sendFile(page)
        return
      }
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(path.join(dist, 'app.html'))
    })
  }
}
