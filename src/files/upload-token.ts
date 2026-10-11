import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Our own "presigned post": the client posts this token back with the file
 * (SPEC.md §7). An HMAC over the claims, so nothing is stored server-side.
 */
export interface UploadClaims {
  key: string
  type: string
  userId: string
  maxBytes: number
  /** Expiry, ms since epoch. */
  exp: number
}

export const UPLOAD_TOKEN_TTL_MS = 60 * 60 * 1000

function sign (payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function createUploadToken (claims: UploadClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

/** The claims, or undefined if the token is malformed, forged or expired. */
export function verifyUploadToken (token: unknown, secret: string, now = Date.now()): UploadClaims | undefined {
  if (typeof token !== 'string') return undefined
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra !== undefined) return undefined
  const expected = Buffer.from(sign(payload, secret))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as UploadClaims
    if (typeof claims.exp !== 'number' || claims.exp < now) return undefined
    return claims
  } catch {
    return undefined
  }
}
