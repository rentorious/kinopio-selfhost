import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { embedFor } from '../src/previews/embeds'
import { readMeta } from '../src/previews/html-meta'
import { isPrivateAddress } from '../src/previews/safe-fetch'
import { setup, TestContext } from './helpers'

const OG_PAGE = `<!doctype html><html><head>
<meta charset="utf-8">
<title>Fallback title</title>
<meta property="og:title" content="Rhizosphere &amp; Vines">
<meta property="og:description" content="Roots, microbes  and
  wine">
<meta property="og:image" content="/img/cover.png">
<link rel="shortcut icon" href="/fav.png">
</head><body><meta property="og:title" content="not this one"></body></html>`

function startSite (): Promise<{ server: http.Server, base: string }> {
  const server = http.createServer((req, res) => {
    const send = (status: number, type: string, body: string | Buffer) => { res.writeHead(status, { 'Content-Type': type }); res.end(body) }
    switch (req.url) {
      case '/og': return send(200, 'text/html; charset=utf-8', OG_PAGE)
      case '/plain': return send(200, 'text/html', '<html><head><title>  Just a\n title </title></head></html>')
      case '/latin1': return send(200, 'text/html; charset=iso-8859-1', Buffer.from('<title>Caf\xe9</title>', 'latin1'))
      case '/redirect': res.writeHead(302, { Location: '/og' }); return res.end()
      case '/redirect-private': res.writeHead(302, { Location: 'http://10.0.0.1/secret' }); return res.end()
      case '/broken': return send(500, 'text/html', '<title>error page</title>')
      case '/json': return send(200, 'application/json', '{"title":"nope"}')
      case '/slow': return // never answers
      default: return send(404, 'text/html', 'nope')
    }
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
  }))
}

describe('link previews', () => {
  let site: { server: http.Server, base: string }
  let t: TestContext
  let apiKey: string

  beforeAll(async () => { site = await startSite() })
  afterAll(async () => {
    site.server.closeAllConnections()
    await new Promise(resolve => site.server.close(resolve))
  })

  async function start (allowHosts: string[]) {
    t = await setup({ urlPreview: { allowHosts, timeoutMs: 1000 } })
    apiKey = String((await t.users.createUser({ email: 'me@x.com', password: 'pw', withInbox: true })).apiKey)
  }
  afterEach(async () => { await t.close() })

  const preview = (url: string) => t.http().post('/api/services/url-preview').set('Authorization', apiKey).send({ url, card: { id: 'card1', name: url } })

  describe('fetching (127.0.0.1 allowlisted for the test site)', () => {
    beforeEach(async () => { await start(['127.0.0.1']) })

    it('returns a card patch with og fields, absolute urls and the exact requested url', async () => {
      const url = `${site.base}/og`
      const res = await preview(url).expect(200)
      expect(res.body).toEqual({
        id: 'card1',
        urlPreviewUrl: url,
        urlPreviewTitle: 'Rhizosphere & Vines',
        urlPreviewDescription: 'Roots, microbes and wine',
        urlPreviewImage: `${site.base}/img/cover.png`,
        urlPreviewFavicon: `${site.base}/fav.png`,
        urlPreviewIframeUrl: '',
        urlPreviewIsVisible: true,
        shouldUpdateUrlPreview: false
      })
    })

    it('falls back to <title> and /favicon.ico', async () => {
      const res = await preview(`${site.base}/plain`).expect(200)
      expect(res.body.urlPreviewTitle).toBe('Just a title')
      expect(res.body.urlPreviewFavicon).toBe(`${site.base}/favicon.ico`)
      expect(res.body.urlPreviewImage).toBe('')
    })

    it('decodes the page charset', async () => {
      expect((await preview(`${site.base}/latin1`).expect(200)).body.urlPreviewTitle).toBe('Café')
    })

    it('follows redirects but keeps the requested url', async () => {
      const url = `${site.base}/redirect`
      const res = await preview(url).expect(200)
      expect(res.body.urlPreviewUrl).toBe(url)
      expect(res.body.urlPreviewTitle).toBe('Rhizosphere & Vines')
    })

    it('answers 404 for error pages, non-HTML, timeouts, and redirects into private networks', async () => {
      for (const path of ['/broken', '/json', '/slow', '/redirect-private', '/missing']) {
        const res = await preview(`${site.base}${path}`)
        expect([path, res.status]).toEqual([path, 404])
      }
    })

    it('rejects non-http urls and needs a signed-in user', async () => {
      await preview('file:///etc/passwd').expect(404)
      await preview('javascript:alert(1)').expect(404)
      await t.http().post('/api/services/url-preview').send({ url: `${site.base}/og` }).expect(401)
    })
  })

  describe('SSRF guard (nothing allowlisted)', () => {
    beforeEach(async () => { await start([]) })

    it('refuses loopback, private, link-local and internal hosts', async () => {
      const port = new URL(site.base).port
      for (const url of [
        `${site.base}/og`,
        `http://localhost:${port}/og`,
        `http://[::1]:${port}/og`,
        'http://10.0.0.1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://[fd00::1]/',
        'http://[::ffff:127.0.0.1]/',
        'http://postgres.railway.internal/'
      ]) {
        const res = await preview(url)
        expect([url, res.status]).toEqual([url, 404])
      }
    })

    it('still gives YouTube links an embed when the site itself can\'t be reached', async () => {
      const url = 'https://youtu.be/dQw4w9WgXcQ?t=42'
      const res = await preview(url).expect(200)
      expect(res.body.urlPreviewUrl).toBe(url)
      expect(res.body.urlPreviewIframeUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42')
      expect(res.body.urlPreviewTitle).toBeTruthy()
    })
  })
})

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true], ['10.1.2.3', true], ['172.20.0.1', true], ['192.168.1.1', true], ['169.254.169.254', true],
    ['100.64.0.1', true], ['0.0.0.0', true], ['::1', true], ['fd00::1', true], ['fe80::1', true], ['::ffff:10.0.0.1', true],
    ['8.8.8.8', false], ['1.1.1.1', false], ['2606:4700:4700::1111', false], ['::ffff:8.8.8.8', false]
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected)
  })
})

describe('embedFor', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://youtube.com/shorts/abcDEF12345', 'https://www.youtube-nocookie.com/embed/abcDEF12345'],
    ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
    ['https://example.com/watch?v=dQw4w9WgXcQ', undefined],
    ['https://vimeo.com/channels/staffpicks', undefined]
  ])('%s', (url, iframe) => {
    expect(embedFor(url)?.iframeUrl).toBe(iframe)
  })
})

describe('readMeta', () => {
  it('ignores tags outside <head> and prefers og over twitter over plain', () => {
    const meta = readMeta('<head><meta name="twitter:title" content="tw"><meta name="description" content="plain"></head><meta property="og:title" content="body">', 'https://x.com/a')
    expect(meta.title).toBe('tw')
    expect(meta.description).toBe('plain')
  })
})
