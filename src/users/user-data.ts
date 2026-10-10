import { JsonObject } from '../db/database'

/**
 * Keys never written into `users.prefs`, from sign-up or the updateUser
 * operation (SPEC.md §6.1). Identity, auth and billing are server-owned;
 * counters and timestamps live in columns; favorites/hidden are separate
 * endpoints; the rest is queue envelope.
 */
export const PROTECTED_USER_KEYS = new Set([
  'id', 'apiKey', 'email', 'password', 'passwordHash', 'passwordResetToken', 'sessionToken', 'currentUser',
  'stripeSubscriptionId', 'stripePlanIsPurchased', 'stripeCustomerId', 'appleSubscriptionIsActive', 'downgradeAt',
  'isModerator', 'isDonor', 'isUpgraded', 'isAmbassador',
  'cardsCreatedCount', 'cardsCreatedCountRaw', 'createdAt', 'updatedAt',
  'favoriteUsers', 'favoriteSpaces', 'favoriteColors', 'hiddenSpaces',
  'operationId', 'spaceId', 'userId', 'clientCreatedAt', 'isFromBroadcast'
])

export function prefsFrom (body: JsonObject): JsonObject {
  const prefs: JsonObject = {}
  for (const [key, value] of Object.entries(body)) {
    if (PROTECTED_USER_KEYS.has(key) || value === undefined) continue
    prefs[key] = value
  }
  return prefs
}

export interface UserRow {
  id: string
  email: string | null
  api_key: string
  prefs: JsonObject
  cards_created_count: number
  cards_created_count_raw: number
  created_at: Date
  updated_at: Date
}

/** The full user object for sign-in, sign-up and GET /user. Columns win over prefs. */
export function userObject (row: UserRow, overrides: JsonObject = {}): JsonObject {
  return {
    ...row.prefs,
    ...overrides,
    id: row.id,
    email: row.email,
    apiKey: row.api_key,
    cardsCreatedCount: row.cards_created_count,
    cardsCreatedCountRaw: row.cards_created_count_raw,
    // The client derives isUpgraded from billing fields and ignores ours.
    // This lifts the 100-card and 5 MB upload limits.
    stripePlanIsPurchased: true,
    isModerator: false,
    isDonor: false,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }
}

/** Public meta, as the client's utils.userMeta shapes it, for space.users. */
export function publicMeta (row: { id: string, prefs: JsonObject }): JsonObject {
  const p = row.prefs ?? {}
  return {
    id: row.id,
    name: p.name ?? null,
    color: p.color ?? null,
    description: p.description ?? null,
    website: p.website ?? null,
    isUpgraded: true,
    isModerator: false,
    isDonor: false
  }
}
