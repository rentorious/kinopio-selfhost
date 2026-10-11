import { randomBytes } from 'node:crypto'
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
  /** Where uploads live (SPEC.md §7): a directory, or an S3-compatible bucket (Railway). */
  files: LocalFilesConfig | BucketFilesConfig
  /** HMAC key for upload tokens. Without UPLOAD_SIGNING_SECRET a random one is made at boot. */
  uploadSigningSecret: string
  uploadMaxBytes: number
  urlPreview: {
    /** Hosts that may be fetched even though they resolve to private addresses (SSRF guard exceptions). */
    allowHosts: string[]
    timeoutMs: number
  }
}

export interface LocalFilesConfig {
  driver: 'local'
  dir: string
}

export interface BucketFilesConfig {
  driver: 's3'
  bucket: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Older Railway buckets need path-style URLs; the bucket's Credentials tab says which. */
  forcePathStyle: boolean
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
    },
    files: loadFilesConfig(),
    uploadSigningSecret: env('UPLOAD_SIGNING_SECRET', randomBytes(32).toString('base64url')),
    uploadMaxBytes: Number(env('UPLOAD_MAX_BYTES', String(256 * 1024 * 1024))),
    urlPreview: {
      allowHosts: env('URL_PREVIEW_ALLOW_HOSTS', '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
      timeoutMs: Number(env('URL_PREVIEW_TIMEOUT_MS', '5000'))
    }
  }
}

/** FILES_DRIVER defaults to s3 when Railway's bucket variables are present, else local. */
function loadFilesConfig (): Config['files'] {
  const driver = env('FILES_DRIVER', process.env.BUCKET ? 's3' : 'local')
  if (driver === 'local') return { driver, dir: path.resolve(env('FILES_DIR', 'data/files')) }
  if (driver !== 's3') throw new Error('FILES_DRIVER must be local or s3')
  return {
    driver,
    bucket: env('BUCKET'),
    endpoint: env('ENDPOINT'),
    region: env('REGION', 'auto'),
    accessKeyId: env('ACCESS_KEY_ID'),
    secretAccessKey: env('SECRET_ACCESS_KEY'),
    forcePathStyle: env('BUCKET_FORCE_PATH_STYLE', 'false') === 'true'
  }
}

export const CONFIG = Symbol('CONFIG')
