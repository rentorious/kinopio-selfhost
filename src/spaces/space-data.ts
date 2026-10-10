import { ItemType, JsonObject } from '../db/database'

/** Space fields stored in their own columns rather than in `meta`. */
const SPACE_COLUMN_KEYS = new Set([
  'id', 'name', 'privacy', 'collaboratorKey', 'readOnlyKey', 'isRemoved', 'removedByUserId',
  'editedAt', 'editedByUserId', 'createdAt', 'updatedAt', 'userId'
])

/** Nested item arrays: stored as rows in `items`. */
const SPACE_NESTED_KEYS = new Set([
  'cards', 'removedCards', 'connections', 'connectionTypes', 'boxes', 'lists', 'lines', 'tags', 'drawingStrokes'
])

/**
 * Never stored. `users` can carry the full local user state including the
 * apiKey and email (OPERATIONS.md, createSpace). The rest are client-derived,
 * per-viewer, or queue envelope fields.
 */
const SPACE_DROP_KEYS = new Set([
  'users', 'collaborators', 'clients', 'spectators', 'groups', 'group', 'otherUsers', 'user',
  'cacheDate', 'removeDate', 'url', 'updateHash', 'currentUserIsCollaborator', 'isFavorite', 'isHidden',
  'isEdited', 'addedToGroupByUserId', 'moonPhase', 'ownerUserId', 'isFromBroadcast',
  'operationId', 'spaceId', 'clientCreatedAt'
])

/** Fields stripped from every stored item (envelope, client-only, or kept in columns). */
const ITEM_DROP_KEYS = new Set([
  'operationId', 'clientCreatedAt', 'spaceId', 'userId', 'createdAt', 'updatedAt',
  'position', 'isParentCard', 'user', 'isFromBroadcast'
])

export const PRIVACY_VALUES = new Set(['private', 'closed', 'open'])

export function spaceMetaFrom (body: JsonObject): JsonObject {
  const meta: JsonObject = {}
  for (const [key, value] of Object.entries(body)) {
    if (SPACE_COLUMN_KEYS.has(key) || SPACE_NESTED_KEYS.has(key) || SPACE_DROP_KEYS.has(key)) continue
    if (key === 'drawingImage' && typeof value === 'string' && value.startsWith('data:')) continue
    meta[key] = value
  }
  return meta
}

export function itemDataFrom (item: JsonObject): JsonObject {
  const data: JsonObject = {}
  for (const [key, value] of Object.entries(item)) {
    if (ITEM_DROP_KEYS.has(key) || value === undefined) continue
    data[key] = value
  }
  return data
}

export function parseDate (value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = new Date(value as string | number)
  return Number.isNaN(date.getTime()) ? null : date
}

export interface ExtractedItem {
  type: ItemType
  id: string
  userId: string | null
  createdAt: Date | null
  data: unknown
}

const ARRAY_TYPES: Array<[string, ItemType]> = [
  ['cards', 'card'], ['connections', 'connection'], ['boxes', 'box'],
  ['lists', 'list'], ['lines', 'line'], ['tags', 'tag']
]

/**
 * Turn a full space body into item rows. `removedCards` become cards with
 * isRemoved: true. Legacy `connectionTypes` are folded into connections the way
 * the client's migrateConnectionTypes does. Drawing strokes arrive newest first
 * (the order we serve them), so they're returned oldest first for insertion.
 */
export function extractItems (body: JsonObject, isValidId: (v: unknown) => v is string): ExtractedItem[] {
  const out: ExtractedItem[] = []
  const seen = new Set<string>()
  const push = (type: ItemType, raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const item = raw as JsonObject
    if (!isValidId(item.id)) return
    const key = `${type}:${item.id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      type,
      id: item.id,
      userId: typeof item.userId === 'string' ? item.userId : null,
      createdAt: parseDate(item.createdAt),
      data: itemDataFrom(item)
    })
  }

  const connectionTypes = new Map<string, JsonObject>()
  if (Array.isArray(body.connectionTypes)) {
    for (const t of body.connectionTypes as JsonObject[]) {
      if (t && typeof t.id === 'string') connectionTypes.set(t.id, t)
    }
  }

  for (const [key, type] of ARRAY_TYPES) {
    const list = body[key]
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      if (type === 'connection' && raw && typeof raw === 'object') {
        const conn = raw as JsonObject
        const legacy = typeof conn.connectionTypeId === 'string' ? connectionTypes.get(conn.connectionTypeId) : undefined
        if (legacy && !conn.name && !conn.color) {
          push(type, { ...conn, name: legacy.name, color: legacy.color })
          continue
        }
      }
      push(type, raw)
    }
  }
  if (Array.isArray(body.removedCards)) {
    for (const raw of body.removedCards) {
      if (raw && typeof raw === 'object') push('card', { ...(raw as JsonObject), isRemoved: true })
    }
  }
  if (Array.isArray(body.drawingStrokes)) {
    const strokes = [...body.drawingStrokes].reverse()
    for (const stroke of strokes) {
      if (!Array.isArray(stroke) || stroke.length === 0) continue
      const first = stroke[0] as JsonObject
      if (!first || !isValidId(first.id)) continue
      const key = `drawingStroke:${first.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ type: 'drawingStroke', id: first.id, userId: typeof first.userId === 'string' ? first.userId : null, createdAt: null, data: stroke })
    }
  }
  return out
}

/** Same as the client's utils.url(): normalized name, dash, id. */
export function spaceUrl (name: string, id: string): string {
  if (!name) return id
  const normalized = name.replace(/'|"|‘|’|“|”/ig, '').replace(/([^a-z0-9-]+)/ig, '-').toLowerCase()
  return `${normalized}-${id}`
}

export interface ItemRow {
  type: ItemType
  id: string
  user_id: string | null
  data: unknown
  created_at: Date
  updated_at: Date
}

export function itemFromRow (row: ItemRow, spaceId: string): unknown {
  if (row.type === 'drawingStroke') return row.data
  return {
    ...(row.data as JsonObject),
    id: row.id,
    spaceId,
    userId: row.user_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }
}
