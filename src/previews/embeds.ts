/**
 * Video sites the client can play inline: the preview gets an embed URL in
 * `urlPreviewIframeUrl`, plus the site's oEmbed endpoint for title and image
 * (more reliable than scraping their HTML, which can be a consent page).
 */
export interface Embed {
  iframeUrl: string
  oembedUrl: string
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/

function youtubeId (url: URL): string | undefined {
  const host = url.hostname.replace(/^(www|m|music)\./, '')
  if (host === 'youtu.be') return url.pathname.split('/')[1]
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return undefined
  if (url.pathname === '/watch') return url.searchParams.get('v') ?? undefined
  const m = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname)
  return m?.[2]
}

export function embedFor (rawUrl: string): Embed | undefined {
  let url: URL
  try { url = new URL(rawUrl) } catch { return undefined }
  const yt = youtubeId(url)
  if (yt && YOUTUBE_ID.test(yt)) {
    const start = Number.parseInt(url.searchParams.get('t') ?? '', 10)
    return {
      iframeUrl: `https://www.youtube-nocookie.com/embed/${yt}${start > 0 ? `?start=${start}` : ''}`,
      oembedUrl: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt}`)}`
    }
  }
  const host = url.hostname.replace(/^www\./, '')
  const vimeo = host === 'vimeo.com' ? /^\/(\d+)/.exec(url.pathname)?.[1] : undefined
  if (vimeo) {
    return {
      iframeUrl: `https://player.vimeo.com/video/${vimeo}`,
      oembedUrl: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${vimeo}`)}`
    }
  }
  return undefined
}
