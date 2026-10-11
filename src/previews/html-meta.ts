/**
 * Just enough HTML reading for link previews: <title>, <meta> and <link> tags
 * in the page's head. No DOM library; previews only need a few attributes.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function decodeEntities (text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    const lower = code.toLowerCase()
    if (lower.startsWith('#x')) return safeChar(parseInt(lower.slice(2), 16), whole)
    if (lower.startsWith('#')) return safeChar(parseInt(lower.slice(1), 10), whole)
    return ENTITIES[lower] ?? whole
  })
}

function safeChar (code: number, fallback: string): string {
  try { return String.fromCodePoint(code) } catch { return fallback }
}

/** Attributes of every `<tag …>` with the given name. */
function tags (html: string, name: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = []
  const tagPattern = new RegExp(`<${name}\\b([^>]*)>`, 'gi')
  const attrPattern = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g
  for (const m of html.matchAll(tagPattern)) {
    const attrs: Record<string, string> = {}
    for (const a of m[1].matchAll(attrPattern)) attrs[a[1].toLowerCase()] = decodeEntities(a[3] ?? a[4] ?? a[5] ?? '')
    out.push(attrs)
  }
  return out
}

export interface PageMeta {
  title?: string
  description?: string
  image?: string
  favicon?: string
}

const clean = (s: string | undefined, max: number): string | undefined => {
  const v = s?.replace(/\s+/g, ' ').trim()
  return v ? v.slice(0, max) : undefined
}

function absolute (href: string | undefined, base: string): string | undefined {
  if (!href) return undefined
  try {
    const url = new URL(href.trim(), base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export function readMeta (html: string, pageUrl: string): PageMeta {
  // everything that matters is in <head>; stop there when we can
  const headEnd = html.search(/<\/head>/i)
  const head = headEnd > 0 ? html.slice(0, headEnd) : html

  const meta = new Map<string, string>()
  for (const attrs of tags(head, 'meta')) {
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop)?.toLowerCase()
    if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, attrs.content)
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]

  const icons = tags(head, 'link').filter(l => /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(l.rel ?? '') && l.href)
  const icon = icons.find(l => /(^|\s)icon(\s|$)/i.test(l.rel)) ?? icons[0]

  return {
    title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? (titleTag ? decodeEntities(titleTag) : undefined), 300),
    description: clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 1000),
    image: absolute(meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('og:image:secure_url') ?? meta.get('twitter:image') ?? meta.get('twitter:image:src'), pageUrl),
    favicon: absolute(icon?.href, pageUrl) ?? absolute('/favicon.ico', pageUrl)
  }
}

/** Decode a page body using the charset from its Content-Type or <meta charset>, falling back to UTF-8. */
export function decodeBody (body: Buffer, contentType: string): string {
  const fromHeader = /charset=([^;\s]+)/i.exec(contentType)?.[1]
  const fromMeta = /<meta[^>]+charset=["']?([^"'\s/>]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1]
  for (const label of [fromHeader, fromMeta, 'utf-8']) {
    if (!label) continue
    try { return new TextDecoder(label.toLowerCase()).decode(body) } catch { /* unknown label */ }
  }
  return body.toString('utf8')
}
