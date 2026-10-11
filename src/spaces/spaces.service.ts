import { Inject, Injectable } from '@nestjs/common'
import { Kysely, sql } from 'kysely'
import { Database, DB, Db, JsonObject, json } from '../db/database'
import { isValidId, nanoid } from '../common/ids'
import { badRequest, notFound, unauthorized } from '../common/errors'
import { insertItems } from '../items/items.repo'
import { publicMeta } from '../users/user-data'
import { extractItems, ItemRow, itemFromRow, parseDate, PRIVACY_VALUES, spaceMetaFrom, spaceUrl } from './space-data'

type Q = Kysely<Database>

export interface Viewer {
  userId?: string
  /** Space-Authorization header */
  collaboratorKey?: string
  /** Read-Only-Authorization header */
  readOnlyKey?: string
}

interface SpaceRow {
  id: string
  owner_id: string
  name: string
  privacy: string
  collaborator_key: string
  read_only_key: string
  is_removed: boolean
  removed_by_user_id: string | null
  edited_at: Date | null
  edited_by_user_id: string | null
  meta: JsonObject
  created_at: Date
  updated_at: Date
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/** The summary fields the space list and other-space previews read (SPEC.md §6.3). */
function summaryFromRow (r: Pick<SpaceRow, 'id' | 'name' | 'privacy' | 'owner_id' | 'is_removed' | 'removed_by_user_id' | 'edited_at' | 'edited_by_user_id' | 'meta' | 'created_at' | 'updated_at'> & { owner_prefs: JsonObject }): JsonObject {
  const meta: JsonObject = {}
  for (const k of SUMMARY_META_KEYS) if (k in r.meta) meta[k] = r.meta[k]
  return {
    ...meta,
    id: r.id,
    name: r.name,
    url: spaceUrl(r.name, r.id),
    privacy: r.privacy,
    userId: r.owner_id,
    isRemoved: r.is_removed,
    removedByUserId: r.removed_by_user_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    editedAt: iso(r.edited_at),
    editedByUserId: r.edited_by_user_id,
    users: [publicMeta({ id: r.owner_id, prefs: r.owner_prefs })],
    collaborators: [],
    groups: []
  }
}

/** Summary fields the space list UI reads (SPEC.md §6.3). */
const SUMMARY_META_KEYS = ['showInExplore', 'isTemplate', 'previewImage', 'previewThumbnailImage', 'category', 'background', 'backgroundTint']

@Injectable()
export class SpacesService {
  constructor (@Inject(DB) private readonly db: Db) {}

  async row (q: Q, id: string): Promise<SpaceRow | undefined> {
    return await q.selectFrom('spaces').selectAll().where('id', '=', id).executeTakeFirst()
  }

  canRead (row: SpaceRow, viewer: Viewer): boolean {
    if (viewer.userId && row.owner_id === viewer.userId) return true
    if (row.privacy === 'open' || row.privacy === 'closed') return true
    if (viewer.collaboratorKey && viewer.collaboratorKey === row.collaborator_key) return true
    if (viewer.readOnlyKey && viewer.readOnlyKey === row.read_only_key) return true
    return false
  }

  /** Owner only until M4 (collaborators). */
  async canEdit (q: Q, userId: string, spaceId: string): Promise<'ok' | 'notFound' | 'forbidden'> {
    const row = await q.selectFrom('spaces').select('owner_id').where('id', '=', spaceId).executeTakeFirst()
    if (!row) return 'notFound'
    return row.owner_id === userId ? 'ok' : 'forbidden'
  }

  /** GET /space/:id (SPEC.md §6.2). */
  async loadFull (spaceId: string, viewer: Viewer): Promise<JsonObject> {
    if (!isValidId(spaceId)) throw notFound('space not found')
    const row = await this.row(this.db, spaceId)
    if (!row) throw notFound('space not found')
    if (!this.canRead(row, viewer)) throw unauthorized('not allowed to view this space')
    return await this.assemble(this.db, row, viewer)
  }

  async assemble (q: Q, row: SpaceRow, viewer: Viewer): Promise<JsonObject> {
    const [items, owner] = await Promise.all([
      q.selectFrom('items')
        .select(['type', 'id', 'user_id', 'data', 'created_at', 'updated_at'])
        .where('space_id', '=', row.id)
        .orderBy('seq', 'asc')
        .execute() as Promise<ItemRow[]>,
      q.selectFrom('users').select(['id', 'prefs']).where('id', '=', row.owner_id).executeTakeFirst()
    ])
    const lists: Record<string, unknown[]> = { cards: [], connections: [], boxes: [], lists: [], lines: [], tags: [], drawingStrokes: [] }
    const key: Record<string, string> = { card: 'cards', connection: 'connections', box: 'boxes', list: 'lists', line: 'lines', tag: 'tags', drawingStroke: 'drawingStrokes' }
    for (const item of items) lists[key[item.type]].push(itemFromRow(item, row.id))
    // Newest first: the client reverses this on load, then appends new strokes on top.
    lists.drawingStrokes.reverse()

    const isOwner = viewer.userId === row.owner_id
    const holdsCollaboratorKey = !!viewer.collaboratorKey && viewer.collaboratorKey === row.collaborator_key
    return {
      ...row.meta,
      id: row.id,
      name: row.name,
      url: spaceUrl(row.name, row.id),
      privacy: row.privacy,
      userId: row.owner_id,
      isRemoved: row.is_removed,
      removedByUserId: row.removed_by_user_id,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      editedAt: iso(row.edited_at),
      editedByUserId: row.edited_by_user_id,
      collaboratorKey: isOwner || holdsCollaboratorKey ? row.collaborator_key : null,
      readOnlyKey: isOwner ? row.read_only_key : null,
      ...lists,
      users: owner ? [publicMeta(owner)] : [],
      collaborators: [],
      groups: [],
      clients: [],
      spectators: []
    }
  }

  /**
   * POST /item/multiple: the cards and spaces that cards link to (other-card
   * and other-space previews), limited to what the viewer can read.
   */
  async otherItems (viewer: Viewer, cardIds: unknown, spaceIds: unknown): Promise<{ cards: JsonObject[], spaces: JsonObject[] }> {
    const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter(isValidId))].slice(0, 200) : [])
    const wantedSpaces = ids(spaceIds)
    const wantedCards = ids(cardIds)
    const cardRows = wantedCards.length
      ? await this.db.selectFrom('items').select(['type', 'id', 'user_id', 'data', 'created_at', 'updated_at', 'space_id'])
        .where('type', '=', 'card').where('id', 'in', wantedCards).execute()
      : []
    const spaceIdsToLoad = [...new Set([...wantedSpaces, ...cardRows.map(r => r.space_id)])]
    const rows = spaceIdsToLoad.length
      ? await this.db.selectFrom('spaces').innerJoin('users', 'users.id', 'spaces.owner_id')
        .selectAll('spaces').select('users.prefs as owner_prefs')
        .where('spaces.id', 'in', spaceIdsToLoad).execute()
      : []
    const readable = new Map(rows.filter(r => this.canRead(r, viewer)).map(r => [r.id, r]))
    const spaces = wantedSpaces.filter(id => readable.has(id)).map(id => summaryFromRow(readable.get(id)!))
    const cards = cardRows.filter(r => readable.has(r.space_id)).map(r => ({
      ...(itemFromRow(r as ItemRow, r.space_id) as JsonObject),
      spaceName: readable.get(r.space_id)!.name
    }))
    return { cards, spaces }
  }

  /** GET /user/spaces and /user/removed-spaces. */
  async summaries (userId: string, removed: boolean): Promise<JsonObject[]> {
    const rows = await this.db.selectFrom('spaces')
      .innerJoin('users', 'users.id', 'spaces.owner_id')
      .select([
        'spaces.id', 'spaces.name', 'spaces.privacy', 'spaces.owner_id', 'spaces.is_removed', 'spaces.removed_by_user_id',
        'spaces.edited_at', 'spaces.edited_by_user_id', 'spaces.meta', 'spaces.created_at', 'spaces.updated_at',
        'users.prefs as owner_prefs'
      ])
      .where('spaces.owner_id', '=', userId)
      .where('spaces.is_removed', '=', removed)
      .orderBy('spaces.updated_at', 'desc')
      .execute()
    return rows.map(r => summaryFromRow(r))
  }

  /**
   * Create a space from a full client snapshot, items included. If the space
   * already exists it is left untouched: the server copy is the source of
   * truth, and sign-in re-posts every cached (possibly stale) space.
   */
  async insertFullIfAbsent (q: Q, userId: string, body: JsonObject): Promise<'created' | 'exists' | 'forbidden'> {
    if (!body || typeof body !== 'object' || !isValidId(body.id)) throw badRequest('space needs a valid id')
    const id = body.id
    const privacy = typeof body.privacy === 'string' && PRIVACY_VALUES.has(body.privacy) ? body.privacy : 'private'
    const isRemoved = body.isRemoved === true
    const createdAt = parseDate(body.createdAt)
    const inserted = await q.insertInto('spaces')
      .values({
        id,
        owner_id: userId,
        name: typeof body.name === 'string' ? body.name : '',
        privacy,
        collaborator_key: typeof body.collaboratorKey === 'string' && body.collaboratorKey ? body.collaboratorKey : nanoid(),
        read_only_key: typeof body.readOnlyKey === 'string' && body.readOnlyKey ? body.readOnlyKey : nanoid(),
        is_removed: isRemoved,
        removed_by_user_id: isRemoved ? userId : null,
        edited_at: parseDate(body.editedAt),
        edited_by_user_id: typeof body.editedByUserId === 'string' ? body.editedByUserId : null,
        meta: json(spaceMetaFrom(body)),
        ...(createdAt ? { created_at: createdAt } : {})
      })
      .onConflict(oc => oc.column('id').doNothing())
      .executeTakeFirst()
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0) {
      const existing = await q.selectFrom('spaces').select('owner_id').where('id', '=', id).executeTakeFirst()
      return existing?.owner_id === userId ? 'exists' : 'forbidden'
    }
    await insertItems(q, id, extractItems(body, isValidId), userId)
    return 'created'
  }

  /** Partial update from PATCH /space or the updateSpace operation. */
  async updateSpace (q: Q, userId: string, patch: JsonObject): Promise<'ok' | 'notFound' | 'forbidden'> {
    if (!isValidId(patch.id)) return 'notFound'
    const access = await this.canEdit(q, userId, patch.id)
    if (access !== 'ok') return access
    const set: Record<string, unknown> = { updated_at: sql`now()` }
    if (typeof patch.name === 'string') set.name = patch.name
    if (typeof patch.privacy === 'string' && PRIVACY_VALUES.has(patch.privacy)) set.privacy = patch.privacy
    if (typeof patch.collaboratorKey === 'string' && patch.collaboratorKey) set.collaborator_key = patch.collaboratorKey
    if ('editedAt' in patch) set.edited_at = parseDate(patch.editedAt)
    if (typeof patch.editedByUserId === 'string') set.edited_by_user_id = patch.editedByUserId
    const meta = spaceMetaFrom(patch)
    if (Object.keys(meta).length) set.meta = sql`meta || ${json(meta)}`
    await q.updateTable('spaces').set(set).where('id', '=', patch.id).execute()
    return 'ok'
  }

  async setRemoved (q: Q, userId: string, spaceId: string, removed: boolean): Promise<'ok' | 'notFound' | 'forbidden'> {
    const access = await this.canEdit(q, userId, spaceId)
    if (access !== 'ok') return access
    await q.updateTable('spaces')
      .set({ is_removed: removed, removed_by_user_id: removed ? userId : null, updated_at: sql`now()` })
      .where('id', '=', spaceId)
      .execute()
    return 'ok'
  }

  async deleteSpace (q: Q, userId: string, spaceId: string): Promise<'ok' | 'notFound' | 'forbidden'> {
    const access = await this.canEdit(q, userId, spaceId)
    if (access !== 'ok') return access
    await q.deleteFrom('spaces').where('id', '=', spaceId).execute()
    return 'ok'
  }

  async deleteAllRemoved (q: Q, userId: string): Promise<void> {
    await q.deleteFrom('spaces').where('owner_id', '=', userId).where('is_removed', '=', true).execute()
  }

  /** PATCH /space/restore/:id returns the full space: the client reads `.cards` from it. */
  async restore (userId: string, spaceId: string): Promise<JsonObject> {
    if (!isValidId(spaceId)) throw notFound('space not found')
    const result = await this.setRemoved(this.db, userId, spaceId, false)
    if (result === 'notFound') throw notFound('space not found')
    if (result === 'forbidden') throw unauthorized()
    return await this.loadFull(spaceId, { userId })
  }

  /** GET /space/updated-at/:id. Unknown or hidden spaces get nulls, never an error (SPEC.md §6.3). */
  async updatedAt (spaceId: string, viewer: Viewer): Promise<JsonObject> {
    const row = isValidId(spaceId) ? await this.row(this.db, spaceId) : undefined
    if (!row || !this.canRead(row, viewer)) return { id: spaceId, editedAt: null, updatedAt: null }
    return { id: row.id, editedAt: iso(row.edited_at ?? row.updated_at), updatedAt: iso(row.updated_at) }
  }

  async removedCards (userId: string, spaceId: string): Promise<unknown[]> {
    if (!isValidId(spaceId)) throw notFound('space not found')
    const access = await this.canEdit(this.db, userId, spaceId)
    if (access === 'notFound') throw notFound('space not found')
    if (access === 'forbidden') throw unauthorized()
    const rows = await this.db.selectFrom('items')
      .select(['type', 'id', 'user_id', 'data', 'created_at', 'updated_at'])
      .where('space_id', '=', spaceId).where('type', '=', 'card')
      .where(sql<boolean>`(data->>'isRemoved')::boolean is true`)
      .orderBy('updated_at', 'desc')
      .execute() as ItemRow[]
    return rows.map(r => itemFromRow(r, spaceId))
  }

  /**
   * The user's Inbox: the most recently updated non-removed space named
   * exactly "Inbox", created if missing (SPEC.md §6.1).
   */
  async findOrCreateInbox (q: Q, userId: string): Promise<string> {
    const existing = await q.selectFrom('spaces').select('id')
      .where('owner_id', '=', userId).where('name', '=', 'Inbox').where('is_removed', '=', false)
      .orderBy('updated_at', 'desc')
      .executeTakeFirst()
    if (existing) return existing.id
    const id = nanoid()
    await q.insertInto('spaces').values({
      id,
      owner_id: userId,
      name: 'Inbox',
      privacy: 'private',
      collaborator_key: nanoid(),
      read_only_key: nanoid(),
      removed_by_user_id: null,
      edited_at: null,
      edited_by_user_id: null,
      meta: json({})
    }).execute()
    return id
  }

  /** Bump updated_at after an operation touched a space. */
  async touch (q: Q, spaceIds: Iterable<string>): Promise<void> {
    const ids = [...new Set(spaceIds)]
    if (ids.length) await q.updateTable('spaces').set({ updated_at: sql`now()` }).where('id', 'in', ids).execute()
  }
}
