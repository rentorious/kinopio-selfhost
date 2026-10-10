import { Kysely, sql } from 'kysely'
import { Database, ItemType, JsonObject, json } from '../db/database'
import { ExtractedItem } from '../spaces/space-data'

type Q = Kysely<Database>

const CHUNK = 500

/** Bulk insert items for a space; existing rows are left alone. */
export async function insertItems (q: Q, spaceId: string, items: ExtractedItem[], fallbackUserId: string): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK)
    await q.insertInto('items')
      .values(chunk.map(item => ({
        space_id: spaceId,
        type: item.type,
        id: item.id,
        user_id: item.userId ?? fallbackUserId,
        data: json(item.data),
        ...(item.createdAt ? { created_at: item.createdAt } : {})
      })))
      .onConflict(oc => oc.columns(['space_id', 'type', 'id']).doNothing())
      .execute()
  }
}

/** Create or replace one item. Re-creates (undo/redo) keep the original creator. */
export async function upsertItem (q: Q, spaceId: string, type: ItemType, id: string, userId: string, data: unknown): Promise<void> {
  await q.insertInto('items')
    .values({ space_id: spaceId, type, id, user_id: userId, data: json(data) })
    .onConflict(oc => oc.columns(['space_id', 'type', 'id']).doUpdateSet({
      data: sql`excluded.data`,
      updated_at: sql`now()`
    }))
    .execute()
}

/**
 * Merge a partial patch into an item. `null` values clear fields (they're
 * stored as JSON null, which is what the client expects back). A name change
 * older than the stored `nameUpdatedAt` loses, but only when the patch itself
 * carries a `nameUpdatedAt` (OPERATIONS.md rule 4).
 */
export async function patchItem (q: Q, spaceId: string, type: ItemType, id: string, patch: JsonObject): Promise<boolean> {
  const current = await q.selectFrom('items')
    .select(sql<string | null>`data->>'nameUpdatedAt'`.as('nameUpdatedAt'))
    .where('space_id', '=', spaceId).where('type', '=', type).where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!current) return false
  if ('name' in patch && patch.nameUpdatedAt && current.nameUpdatedAt) {
    const stored = Date.parse(current.nameUpdatedAt)
    const incoming = Date.parse(String(patch.nameUpdatedAt))
    if (!Number.isNaN(stored) && !Number.isNaN(incoming) && stored > incoming) {
      patch = { ...patch }
      delete patch.name
      delete patch.nameUpdatedAt
    }
  }
  if (Object.keys(patch).length === 0) return true
  await q.updateTable('items')
    .set({ data: sql`data || ${json(patch)}`, updated_at: sql`now()` })
    .where('space_id', '=', spaceId).where('type', '=', type).where('id', '=', id)
    .execute()
  return true
}

export async function deleteItem (q: Q, spaceId: string, type: ItemType, id: string): Promise<boolean> {
  const res = await q.deleteFrom('items')
    .where('space_id', '=', spaceId).where('type', '=', type).where('id', '=', id)
    .executeTakeFirst()
  return Number(res.numDeletedRows) > 0
}

/** Ids of every space a user owns, for user-wide tag operations. */
export function ownedSpaceIds (q: Q, userId: string) {
  return q.selectFrom('spaces').select('id').where('owner_id', '=', userId)
}
