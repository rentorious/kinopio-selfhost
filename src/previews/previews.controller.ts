import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import { AuthUser, CurrentUser, SignedInGuard } from '../common/auth'
import { ApiError, notFound } from '../common/errors'
import { RateLimiter } from '../common/rate-limit'
import { Config, CONFIG } from '../config'
import { JsonObject } from '../db/database'
import { embedFor } from './embeds'
import { decodeBody, readMeta, PageMeta } from './html-meta'
import { safeFetch } from './safe-fetch'

const MAX_BYTES = 2 * 1024 * 1024

/** Fields from `a`, with gaps filled from `b`. */
function fill (a: PageMeta, b: PageMeta): PageMeta {
  return { title: a.title ?? b.title, description: a.description ?? b.description, image: a.image ?? b.image, favicon: a.favicon ?? b.favicon }
}

/**
 * POST /services/url-preview (SPEC.md §8). The client merges our answer
 * straight into the card and saves it with an updateCard, so only preview
 * fields are returned. It keeps re-requesting unless the status is exactly
 * 200 and urlPreviewUrl is exactly the url it asked about; a 404 marks the
 * url as failed and it won't retry.
 */
@Controller()
export class PreviewsController {
  private readonly limiter = new RateLimiter(60, 60_000)

  constructor (@Inject(CONFIG) private readonly config: Config) {}

  @Post('services/url-preview')
  @HttpCode(200)
  @UseGuards(SignedInGuard)
  async preview (@CurrentUser() user: AuthUser, @Body() body: JsonObject) {
    const url = body?.url
    if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url)) throw notFound('no preview for this url')
    if (!this.limiter.attempt(user.id)) throw new ApiError(429, 'too many previews, try again in a minute')

    const embed = embedFor(url)
    let meta: PageMeta = embed ? await this.oembed(embed.oembedUrl) : {}
    if (!meta.title) meta = fill(meta, await this.page(url))
    if (!meta.title && !meta.image && !embed) throw notFound('no preview for this url')
    meta.favicon ??= new URL('/favicon.ico', url).toString()

    const card = typeof body.card === 'object' && body.card !== null ? body.card as JsonObject : {}
    return {
      ...(typeof card.id === 'string' ? { id: card.id } : {}),
      urlPreviewUrl: url,
      urlPreviewTitle: meta.title ?? url,
      urlPreviewDescription: meta.description ?? '',
      urlPreviewImage: meta.image ?? '',
      urlPreviewFavicon: meta.favicon ?? '',
      urlPreviewIframeUrl: embed?.iframeUrl ?? '',
      urlPreviewIsVisible: true,
      shouldUpdateUrlPreview: false
    }
  }

  private fetchOptions (accept: string) {
    return { timeoutMs: this.config.urlPreview.timeoutMs, maxBytes: MAX_BYTES, allowHosts: this.config.urlPreview.allowHosts, accept }
  }

  private async page (url: string): Promise<PageMeta> {
    try {
      const res = await safeFetch(url, this.fetchOptions('text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'))
      if (!/html|xml/i.test(res.contentType)) return {}
      return readMeta(decodeBody(res.body, res.contentType), res.url)
    } catch {
      return {}
    }
  }

  private async oembed (oembedUrl: string): Promise<PageMeta> {
    try {
      const res = await safeFetch(oembedUrl, this.fetchOptions('application/json'))
      const data = JSON.parse(res.body.toString('utf8')) as JsonObject
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
      return { title: str(data.title), description: str(data.author_name), image: str(data.thumbnail_url) }
    } catch {
      return {}
    }
  }
}
