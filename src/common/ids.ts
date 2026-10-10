import { randomBytes } from 'node:crypto'

const ALPHABET = 'ModuleSymbhasOwnPr-0123456789ABCDEFGHNRVfgctiUvz_KqYTJkLxpZXIjQW'

/** URL-safe random id, same alphabet and default length as nanoid (which the client uses). */
export function nanoid (size = 21): string {
  const bytes = randomBytes(size)
  let id = ''
  for (let i = 0; i < size; i++) id += ALPHABET[bytes[i] & 63]
  return id
}

export function newApiKey (): string {
  return randomBytes(32).toString('base64url')
}

/** Ids the client generates are nanoids; accept a little more but nothing weird. */
export function isValidId (value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)
}
