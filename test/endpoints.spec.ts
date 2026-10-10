import fs from 'node:fs'
import path from 'node:path'
import { STUB_ROUTES } from '../src/stubs/stubs'
import { setup, TestContext } from './helpers'

/**
 * Every endpoint the client calls (docs/ENDPOINTS.md, generated from the
 * client source) must get a JSON answer from the server: never the HTML app
 * shell, never an empty body. STUB rows answer 200, SKIP rows 404.
 */
interface Row { method: string, path: string, tier: string }

function endpointRows (): Row[] {
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ENDPOINTS.md'), 'utf8')
  const rows: Row[] = []
  let tier = ''
  for (const line of md.split('\n')) {
    const heading = /^## (\w+):/.exec(line)
    if (heading) tier = heading[1]
    const m = /^\| `(GET|POST|PATCH|DELETE) ([^`]+)` \|/.exec(line)
    if (m && tier) rows.push({ method: m[1], path: m[2], tier })
  }
  return rows
}

const normalize = (p: string) => p.replace(/\?…$/, '').replace(/:\w+/g, ':param').replace(/(.)\/$/, '$1').replace(/^\/user\/tags:param$/, '/user/tags')

describe('endpoint coverage', () => {
  const rows = endpointRows()
  let t: TestContext
  let apiKey: string

  beforeAll(async () => {
    t = await setup()
    const user = await t.users.createUser({ email: 'me@x.com', password: 'pw', withInbox: true })
    apiKey = String(user.apiKey)
  })
  afterAll(async () => { await t.close() })

  it('parses the inventory', () => {
    expect(rows.length).toBe(104)
  })

  it('has a stub route for every STUB and SKIP row, and no stub for anything else', () => {
    const stubKeys = new Set(STUB_ROUTES.map(r => `${r.method} ${normalize(r.path)}`))
    for (const row of rows.filter(r => r.tier === 'STUB' || r.tier === 'SKIP')) {
      expect([row.tier, `${row.method} ${normalize(row.path)}`, stubKeys.has(`${row.method} ${normalize(row.path)}`)])
        .toEqual([row.tier, `${row.method} ${normalize(row.path)}`, true])
    }
    const docTier = new Map(rows.map(r => [`${r.method} ${normalize(r.path)}`, r.tier]))
    for (const stub of STUB_ROUTES) {
      const key = `${stub.method} ${normalize(stub.path)}`
      expect([key, docTier.get(key)]).toEqual([key, stub.tier])
    }
  })

  for (const row of endpointRows().filter(r => r.tier !== 'DEAD')) {
    it(`${row.tier} ${row.method} ${row.path} answers with JSON`, async () => {
      const url = '/api' + normalize(row.path).replace(/:param/g, 'someId12345')
      const req = t.http()[row.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'](url).set('Authorization', apiKey)
      const res = await (row.method === 'GET' ? req : req.send(row.path === '/operations' ? [] : {}))
      expect([url, res.headers['content-type']]).toEqual([url, expect.stringContaining('application/json')])
      expect(res.status).not.toBe(204)
      if (row.tier === 'STUB' && !(row.method === 'GET' && row.path === '/group/:param')) expect([url, res.status]).toEqual([url, 200])
      if (row.tier === 'SKIP') expect([url, res.status]).toEqual([url, 404])
    })
  }
})
