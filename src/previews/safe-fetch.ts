import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

/**
 * Fetch a public web page for a link preview (SPEC.md §8), refusing anything
 * that resolves to a private, loopback or internal address (SSRF guard).
 *
 * The address check runs inside the socket's DNS lookup, so it applies to the
 * address actually connected to (no DNS-rebinding gap) and to every redirect.
 */

const blocked = new net.BlockList()
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blocked.addSubnet(prefix, bits, 'ipv4')
for (const [prefix, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32], ['100::', 64]
] as const) blocked.addSubnet(prefix, bits, 'ipv6')

/** True for any address a link preview must not reach. Railway's private network is fd00::/8 (inside fc00::/7). */
export function isPrivateAddress (address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    if (mapped) return blocked.check(mapped[1], 'ipv4')
    return blocked.check(address, 'ipv6')
  }
  return true
}

export class FetchError extends Error {}

export interface FetchOptions {
  timeoutMs: number
  maxBytes: number
  /** Hostnames allowed to resolve to private addresses. */
  allowHosts: string[]
  accept: string
  maxRedirects?: number
}

export interface FetchedPage {
  /** URL after redirects. */
  url: string
  contentType: string
  body: Buffer
}

const USER_AGENT = 'Mozilla/5.0 (compatible; kinopio-selfhost link preview)'

function hostnameOf (url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

function checkHost (url: URL, allowHosts: string[]): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('only http and https')
  const host = hostnameOf(url)
  if (allowHosts.includes(host)) return
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.railway.internal')) {
    throw new FetchError('internal host')
  }
  // IP literals skip DNS, so check them here
  if (net.isIP(host) && isPrivateAddress(host)) throw new FetchError('private address')
}

/** A dns.lookup replacement that refuses private results. */
function guardedLookup (allow: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0)
      const list = addresses as dns.LookupAddress[]
      if (!allow && list.some(a => isPrivateAddress(a.address))) {
        return callback(Object.assign(new Error('private address'), { code: 'EPRIVATE' }), '', 0)
      }
      if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list)
      callback(null, list[0].address, list[0].family)
    })
  }
}

export async function safeFetch (rawUrl: string, opts: FetchOptions): Promise<FetchedPage> {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new FetchError('invalid url') }
  const deadline = Date.now() + opts.timeoutMs
  const maxRedirects = opts.maxRedirects ?? 5
  for (let hop = 0; hop <= maxRedirects; hop++) {
    checkHost(url, opts.allowHosts)
    const res = await request(url, opts, deadline)
    if (res.redirect) {
      url = new URL(res.redirect, url)
      continue
    }
    return { url: url.toString(), contentType: res.contentType, body: res.body }
  }
  throw new FetchError('too many redirects')
}

interface RawResponse { redirect?: string, contentType: string, body: Buffer }

function request (url: URL, opts: FetchOptions, deadline: number): Promise<RawResponse> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.reject(new FetchError('timed out'))
  const allow = opts.allowHosts.includes(hostnameOf(url))
  const lib = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: opts.accept, 'Accept-Language': 'en' },
      lookup: guardedLookup(allow),
      agent: false
    }, res => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        resolve({ redirect: res.headers.location, contentType: '', body: Buffer.alloc(0) })
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        reject(new FetchError(`status ${status}`))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        chunks.push(chunk)
        // enough for <head>; a preview never needs more
        if (size >= opts.maxBytes) res.destroy()
      })
      const done = () => resolve({ contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).subarray(0, opts.maxBytes) })
      res.on('end', done)
      res.on('close', done)
      res.on('error', () => done())
    })
    const timer = setTimeout(() => req.destroy(new FetchError('timed out')), remaining)
    req.on('close', () => clearTimeout(timer))
    req.on('error', err => reject(err instanceof FetchError ? err : new FetchError(err.message)))
    req.end()
  })
}
