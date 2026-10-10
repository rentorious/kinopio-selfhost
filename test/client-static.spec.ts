import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { clientStatic } from '../src/common/client-static'

describe('client static serving', () => {
  let dist: string
  let app: express.Express

  beforeAll(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'client-dist-'))
    fs.mkdirSync(path.join(dist, 'assets'))
    fs.writeFileSync(path.join(dist, 'app.html'), '<html>app shell</html>')
    fs.writeFileSync(path.join(dist, 'index.html'), '<html>home</html>')
    fs.writeFileSync(path.join(dist, 'about.html'), '<html>about</html>')
    fs.writeFileSync(path.join(dist, 'sw.js'), '// sw')
    fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), '{}')
    fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), '// bundle')
    fs.writeFileSync(path.join(dist, 'android-chrome-192x192.png'), 'png')
    app = express()
    app.use(clientStatic(dist))
    app.use((_req, res) => { res.status(404).json({ status: 404 }) })
  })

  it('revalidates the service worker, manifest and pages so deploys are picked up', async () => {
    for (const url of ['/sw.js', '/manifest.webmanifest', '/', '/about', '/some-space-abc123']) {
      const res = await request(app).get(url).expect(200)
      expect([url, res.headers['cache-control']]).toEqual([url, 'no-cache'])
    }
  })

  it('caches hashed bundles forever and other files for an hour', async () => {
    expect((await request(app).get('/assets/app-abc123.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect((await request(app).get('/android-chrome-192x192.png')).headers['cache-control']).toBe('public, max-age=3600')
  })

  it('serves pre-rendered pages, falls back to the app shell, and leaves /api and /files alone', async () => {
    expect((await request(app).get('/about')).text).toContain('about')
    expect((await request(app).get('/app')).text).toContain('app shell')
    expect((await request(app).get('/my-space-xyz')).text).toContain('app shell')
    await request(app).get('/api/anything').expect(404)
    await request(app).get('/files/x/y.png').expect(404)
    expect((await request(app).get('/../../etc/passwd')).text).toContain('app shell')
  })
})
