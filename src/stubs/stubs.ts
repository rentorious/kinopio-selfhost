import express, { Request, Response, Router } from 'express'

/**
 * Fixed answers for every endpoint the client calls that we don't implement
 * (yet). Tiers match docs/ENDPOINTS.md:
 *   STUB  - permanent fixed answer
 *   SKIP  - not supported: JSON 404
 *   M2/M3/M4 - interim answer until that milestone builds the real thing
 *
 * Mounted before the Nest routes, so these paths must never overlap a real
 * route (test/stubs.spec.ts checks this table against ENDPOINTS.md).
 */
export interface StubRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  tier: 'STUB' | 'SKIP' | 'M2' | 'M3' | 'M4'
  status: number
  body: unknown | ((req: Request) => unknown)
}

const notSupported = { status: 404, message: 'not supported' }
const skip = (method: StubRoute['method'], path: string): StubRoute => ({ method, path, tier: 'SKIP', status: 404, body: notSupported })
const stub = (method: StubRoute['method'], path: string, body: StubRoute['body'], tier: StubRoute['tier'] = 'STUB'): StubRoute => ({ method, path, tier, status: 200, body })

export function origin (req: Request): string {
  return `${req.protocol}://${req.get('host')}`
}

function today (): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${d.getUTCFullYear()}`
}

export const STUB_ROUTES: StubRoute[] = [
  // meta / misc
  stub('GET', '/meta/changelog', []),
  stub('GET', '/meta/emojis', { emojis: [], version: 1 }),
  stub('GET', '/space/date-image', (req: Request) => ({ url: `${origin(req)}/api/date-card/${today()}.svg` })),
  stub('POST', '/services/analytics-event', {}),
  skip('POST', '/kinopio-blog/new-post/subscribe'),
  skip('POST', '/moderator/restart-server'),

  // auth extras
  skip('POST', '/user/send-reset-password-email'),
  skip('PATCH', '/user/reset-password'),
  { method: 'PATCH', path: '/user/update-password', tier: 'M3', status: 404, body: notSupported },
  { method: 'PATCH', path: '/user/update-email', tier: 'M3', status: 404, body: notSupported },

  // user lists (six of these load together; any error blocks all of them)
  stub('GET', '/user/favorite-spaces', []),
  stub('GET', '/user/favorite-users', []),
  stub('GET', '/user/favorite-colors', []),
  stub('GET', '/user/hidden-spaces', [], 'M3'),
  stub('GET', '/user/tags', [], 'M3'),
  stub('GET', '/user/groups', []),
  stub('GET', '/user/favorite-users-spaces', []),
  stub('GET', '/user/template-spaces', []),
  stub('GET', '/user/group-spaces', []),
  stub('GET', '/user/todos', [], 'M3'),
  stub('GET', '/user/at-user-mentions', []),
  stub('GET', '/user/at-date-mentions', [], 'M3'),
  stub('GET', '/user/spaces-notification-unsubscribed', []),
  stub('GET', '/user/groups-notification-unsubscribed', []),
  skip('GET', '/space/:id/notification-resubscribe'),
  skip('GET', '/group/:id/notification-resubscribe'),
  { method: 'DELETE', path: '/user/permanent', tier: 'M4', status: 404, body: notSupported },
  stub('GET', '/user/public/multiple', [], 'M3'),
  stub('GET', '/user/public/explore-spaces/:id', []),
  { method: 'GET', path: '/user/public/:id', tier: 'M3', status: 404, body: notSupported },
  stub('PATCH', '/user/favorites', {}),
  skip('PATCH', '/user/update-arena-access-token'),
  skip('PATCH', '/user/apply-student-discount'),

  // spaces
  stub('GET', '/space/explore-spaces', []),
  stub('GET', '/space/everyone-spaces', []),
  stub('GET', '/space/live-spaces', []),
  stub('POST', '/space/search-explore-spaces', []),
  stub('GET', '/space/public/multiple', []),
  stub('GET', '/space/:id/favorites', []),
  stub('GET', '/space/:id/history', []),
  stub('POST', '/space/drawing-image', {}),
  stub('POST', '/space/preview-image', {}),
  skip('POST', '/space/email-invites/:id'),
  { method: 'PATCH', path: '/space/collaborator', tier: 'M4', status: 401, body: { status: 401, message: 'sharing is not supported yet' } },
  { method: 'DELETE', path: '/space/collaborator', tier: 'M4', status: 404, body: notSupported },
  { method: 'GET', path: '/space/download-all', tier: 'M3', status: 404, body: notSupported },

  // items
  stub('GET', '/card/by-link-to-space/:id', { spaces: [], cards: [] }),
  stub('GET', '/card/:id/history', []),
  stub('POST', '/card/search', [], 'M3'),
  stub('GET', '/card/by-tag-name/:name', [], 'M3'),
  { method: 'PATCH', path: '/card/multiple', tier: 'M3', status: 404, body: notSupported },
  { method: 'PATCH', path: '/card/update-counter', tier: 'M3', status: 404, body: notSupported },
  { method: 'PATCH', path: '/box', tier: 'M3', status: 404, body: notSupported },

  // billing, keys, groups
  skip('POST', '/billing/stripe/checkout-url'),
  skip('POST', '/billing/stripe/subscription-url'),
  skip('POST', '/billing/stripe/customer-portal-url'),
  skip('POST', '/billing/stripe/donation-url'),
  skip('GET', '/affiliate'),
  stub('GET', '/app-api-key', []),
  skip('POST', '/app-api-key'),
  skip('PATCH', '/app-api-key/rotate-key'),
  skip('DELETE', '/app-api-key'),
  { method: 'GET', path: '/group/:id', tier: 'STUB', status: 404, body: { status: 404, message: 'groups are not supported' } },
  skip('GET', '/group/:id/public-meta'),
  skip('POST', '/group'),
  skip('POST', '/group/group-user'),
  skip('DELETE', '/group/group-user'),
  skip('DELETE', '/group'),

  // notifications, services
  stub('GET', '/notification', []),
  stub('DELETE', '/notification/all', {}),
  stub('POST', '/services/image-search', { photos: [] }),
  stub('POST', '/services/gif-image-search', []),
  stub('GET', '/services/community-backgrounds', []),
  skip('POST', '/services/pdf')
]

export function stubRouter (routes: StubRoute[] = STUB_ROUTES): Router {
  const router = express.Router()
  for (const route of routes) {
    const handler = (req: Request, res: Response) => {
      const body = typeof route.body === 'function' ? (route.body as (r: Request) => unknown)(req) : route.body
      res.status(route.status).json(body)
    }
    router[route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'](route.path, handler)
  }
  return router
}

/** A small date tile for the date card the client puts on new spaces. */
export function dateCardSvg (mmddyyyy: string): string | undefined {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(mmddyyyy)
  if (!m) return undefined
  const month = Number(m[1])
  const day = Number(m[2])
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const name = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][month - 1]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="188" height="188" viewBox="0 0 188 188">
<rect width="188" height="188" rx="12" fill="#fdfcf7"/>
<rect width="188" height="48" rx="12" fill="#e9a28c"/><rect y="36" width="188" height="12" fill="#e9a28c"/>
<text x="94" y="34" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#fff">${name}</text>
<text x="94" y="140" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="80" font-weight="700" fill="#2f2f2f">${day}</text>
</svg>`
}
