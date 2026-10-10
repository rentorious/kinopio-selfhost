import path from 'node:path'

export interface Config {
  port: number
  databaseUrl: string
  databaseSsl: boolean
  /** 'true' | 'false' | 'first-user' (default): first-user allows sign-up only while no users exist */
  allowSignup: 'true' | 'false' | 'first-user'
  /** Directory holding the built, patched Kinopio client. Missing dir = API only. */
  clientDist: string
  /** Max JSON body size. Sign-in posts every locally cached space at once. */
  jsonLimit: string
  signInRateLimit: { max: number, windowMs: number }
}

function env (name: string, fallback?: string): string {
  const value = process.env[name]
  if (value !== undefined && value !== '') return value
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required env var ${name}`)
}

export function loadConfig (): Config {
  const allowSignup = env('ALLOW_SIGNUP', 'first-user')
  if (!['true', 'false', 'first-user'].includes(allowSignup)) {
    throw new Error('ALLOW_SIGNUP must be true, false or first-user')
  }
  return {
    port: Number(env('PORT', '3000')),
    databaseUrl: env('DATABASE_URL', 'postgres://postgres@127.0.0.1:5432/kinopio'),
    databaseSsl: env('DATABASE_SSL', 'false') === 'true',
    allowSignup: allowSignup as Config['allowSignup'],
    clientDist: path.resolve(env('CLIENT_DIST', 'client-dist')),
    jsonLimit: env('JSON_LIMIT', '50mb'),
    signInRateLimit: {
      max: Number(env('SIGN_IN_RATE_MAX', '10')),
      windowMs: Number(env('SIGN_IN_RATE_WINDOW_MS', String(15 * 60 * 1000)))
    }
  }
}

export const CONFIG = Symbol('CONFIG')
