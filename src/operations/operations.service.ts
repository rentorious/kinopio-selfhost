import { Inject, Injectable, Logger } from '@nestjs/common'
import { Kysely, sql } from 'kysely'
import { Database, DB, Db, ItemType, JsonObject, json } from '../db/database'
import { isValidId } from '../common/ids'
import { deleteItem, ownedSpaceIds, patchItem, upsertItem } from '../items/items.repo'
import { itemDataFrom } from '../spaces/space-data'
import { SpacesService } from '../spaces/spaces.service'
import { UsersService } from '../users/users.service'

type Q = Kysely<Database>

/** An op failure. 400/401/404 are "non-critical" to the client; anything else shows its save-error banner. */
export class OpError extends Error {
  constructor (readonly status: number, message: string) { super(message) }
}

export interface OperationError {
  status: number
  name: string
  operationId?: string
  message: string
}

interface Ctx {
  trx: Q
  userId: string
  /** body.spaceId: the space the op targets (current space unless the client overrode it) */
  spaceId: string | undefined
  touched: Set<string>
}

type Handler = (ctx: Ctx, body: JsonObject) => Promise<void>

/** Inbox cards are left-aligned at this x, which the client re-stacks (consts.minItemXY). */
const INBOX_XY = 70

/** Accepted and ignored: features outside scope, or later milestones (OPERATIONS.md). */
const ACCEPTED = new Set([
  'updateSpaceIsHidden', 'updateFavoriteSpace', 'updateFavoriteUser', 'updateFavoriteColor',
  'updateUserVisitSpaces', 'updateNotificationsIsRead', 'createUserNotification', 'removeUserNotification',
  'updateUrlPreviewImage', 'addCollaboratorToSpaces',
  'updateGroup', 'updateGroupUser', 'addSpaceToGroup', 'removeSpaceFromGroup',
  'createItem', 'removeItem'
])

@Injectable()
export class OperationsService {
  private readonly logger = new Logger('Operations')
  private readonly handlers: Record<string, Handler>

  constructor (
    @Inject(DB) private readonly db: Db,
    private readonly spaces: SpacesService,
    private readonly users: UsersService
  ) {
    this.handlers = {
      // spaces
      createSpace: async (ctx, body) => {
        const result = await this.spaces.insertFullIfAbsent(ctx.trx, ctx.userId, body)
        if (result === 'forbidden') throw new OpError(401, 'space belongs to someone else')
      },
      updateSpace: async (ctx, body) => this.spaceResult(await this.spaces.updateSpace(ctx.trx, ctx.userId, body)),
      removeSpace: async (ctx, body) => this.spaceResult(await this.spaces.setRemoved(ctx.trx, ctx.userId, this.id(body), true)),
      deleteSpace: async (ctx, body) => {
        const result = await this.spaces.deleteSpace(ctx.trx, ctx.userId, this.id(body))
        if (result === 'forbidden') throw new OpError(401, 'not allowed')
      },
      deleteAllRemovedSpaces: async (ctx) => this.spaces.deleteAllRemoved(ctx.trx, ctx.userId),

      // cards
      createCard: this.create('card'),
      updateCard: this.update('card'),
      removeCard: async (ctx, body) => this.patch(ctx, 'card', this.id(body), { isRemoved: true }),
      deleteCard: this.remove('card'),
      restoreRemovedCard: async (ctx, body) => {
        const spaceId = await this.editable(ctx)
        await upsertItem(ctx.trx, spaceId, 'card', this.id(body), ctx.userId, { ...itemDataFrom(body), isRemoved: false })
      },
      deleteAllRemovedCards: async (ctx) => {
        const spaceId = await this.editable(ctx)
        await ctx.trx.deleteFrom('items')
          .where('space_id', '=', spaceId).where('type', '=', 'card')
          .where(sql<boolean>`(data->>'isRemoved')::boolean is true`)
          .execute()
      },
      createCardInInbox: async (ctx, body) => this.addCardToInbox(ctx.trx, ctx.userId, body, ctx.touched),

      // connections, boxes, lists, lines
      createConnection: this.create('connection'),
      updateConnection: this.update('connection'),
      removeConnection: this.remove('connection'),
      createBox: this.create('box'),
      updateBox: this.update('box'),
      removeBox: this.remove('box'),
      createList: this.create('list'),
      updateList: this.update('list'),
      removeList: async (ctx, body) => {
        await this.remove('list')(ctx, body)
        // the client's own card updates can arrive out of order with this op
        await ctx.trx.updateTable('items')
          .set({ data: sql`data || ${json({ listId: null, listPositionIndex: null })}`, updated_at: sql`now()` })
          .where('space_id', '=', ctx.spaceId!).where('type', '=', 'card')
          .where(sql<boolean>`data->>'listId' = ${this.id(body)}`)
          .execute()
      },
      createLine: this.create('line'),
      updateLine: this.update('line'),
      removeLine: this.remove('line'),

      // drawing
      createDrawingStroke: async (ctx, body) => {
        const stroke = this.stroke(body)
        const spaceId = await this.editable(ctx)
        await upsertItem(ctx.trx, spaceId, 'drawingStroke', (stroke[0] as JsonObject).id as string, ctx.userId, stroke)
      },
      removeDrawingStroke: async (ctx, body) => {
        const stroke = this.stroke(body)
        const spaceId = await this.editable(ctx)
        await deleteItem(ctx.trx, spaceId, 'drawingStroke', (stroke[0] as JsonObject).id as string)
      },
      clearDrawing: async (ctx) => {
        const spaceId = await this.editable(ctx)
        await ctx.trx.deleteFrom('items').where('space_id', '=', spaceId).where('type', '=', 'drawingStroke').execute()
      },

      // tags
      updateTags: async (ctx, body) => {
        const tags = Array.isArray(body.tags) ? body.tags as JsonObject[] : []
        for (const tag of tags) {
          if (!tag || !isValidId(tag.id)) continue
          const spaceId = isValidId(tag.spaceId) ? tag.spaceId : ctx.spaceId
          if (!spaceId) continue
          const access = await this.spaces.canEdit(ctx.trx, ctx.userId, spaceId)
          if (access !== 'ok') continue
          await upsertItem(ctx.trx, spaceId, 'tag', tag.id, ctx.userId, itemDataFrom(tag))
          ctx.touched.add(spaceId)
        }
      },
      // The envelope overwrites the tag's spaceId, so tag removals look across all of the user's spaces.
      removeTag: async (ctx, body) => {
        await ctx.trx.deleteFrom('items')
          .where('type', '=', 'tag').where('id', '=', this.id(body))
          .where('space_id', 'in', ownedSpaceIds(ctx.trx, ctx.userId))
          .execute()
      },
      removeTagsByName: async (ctx, body) => {
        if (typeof body.name !== 'string') throw new OpError(400, 'tag name required')
        await ctx.trx.deleteFrom('items')
          .where('type', '=', 'tag').where(sql<boolean>`data->>'name' = ${body.name}`)
          .where('space_id', 'in', ownedSpaceIds(ctx.trx, ctx.userId))
          .execute()
      },
      updateTagColorByName: async (ctx, body) => {
        const tag = (body.tag ?? {}) as JsonObject
        if (typeof tag.name !== 'string' || typeof tag.color !== 'string') throw new OpError(400, 'tag name and color required')
        await ctx.trx.updateTable('items')
          .set({ data: sql`data || ${json({ color: tag.color })}`, updated_at: sql`now()` })
          .where('type', '=', 'tag').where(sql<boolean>`data->>'name' = ${tag.name}`)
          .where('space_id', 'in', ownedSpaceIds(ctx.trx, ctx.userId))
          .execute()
      },

      // user
      updateUser: async (ctx, body) => this.users.updatePrefs(ctx.trx, ctx.userId, body),
      updateUserCardsCreatedCount: async (ctx, body) => this.users.addCardsCreated(ctx.trx, ctx.userId, body.delta, false),
      updateUserCardsCreatedCountRaw: async (ctx, body) => this.users.addCardsCreated(ctx.trx, ctx.userId, body.delta, true)
    }
  }

  /**
   * Apply a batch in order, one transaction per op, committing each success
   * (OPERATIONS.md). Ops already applied (same operationId) are skipped.
   */
  async apply (userId: string, ops: unknown): Promise<{ errors: OperationError[], applied: number, skipped: number }> {
    if (!Array.isArray(ops)) throw new OpError(400, 'expected an array of operations')
    const errors: OperationError[] = []
    const touched = new Set<string>()
    let applied = 0
    let skipped = 0
    for (const raw of ops) {
      const op = (raw ?? {}) as JsonObject
      const name = typeof op.name === 'string' ? op.name : ''
      const body = normalizeBody(op.body)
      const operationId = typeof body.operationId === 'string' ? body.operationId : undefined
      const handler = this.handlers[name]
      if (!handler) {
        if (!ACCEPTED.has(name)) this.logger.warn(`unknown operation accepted as no-op: ${name}`)
        applied++
        continue
      }
      try {
        const ran = await this.db.transaction().execute(async trx => {
          if (operationId) {
            const fresh = await trx.insertInto('applied_operations').values({ operation_id: operationId })
              .onConflict(oc => oc.column('operation_id').doNothing())
              .executeTakeFirst()
            if (Number(fresh.numInsertedOrUpdatedRows ?? 0) === 0) return false
          }
          const spaceId = isValidId(body.spaceId) ? body.spaceId : undefined
          const opTouched = new Set<string>()
          await handler({ trx, userId, spaceId, touched: opTouched }, body)
          opTouched.forEach(id => touched.add(id))
          return true
        })
        if (ran) applied++
        else skipped++
      } catch (err) {
        const status = err instanceof OpError ? err.status : 500
        if (status === 500) this.logger.error(`${name} failed`, err instanceof Error ? err.stack : String(err))
        errors.push({ status, name, operationId, message: err instanceof Error ? err.message : String(err) })
      }
    }
    await this.spaces.touch(this.db, touched).catch(() => undefined)
    return { errors, applied, skipped }
  }

  /** POST /card/to-inbox and the createCardInInbox op. */
  async addCardToInbox (q: Q, userId: string, body: JsonObject, touched?: Set<string>): Promise<void> {
    if (!isValidId(body.id)) throw new OpError(400, 'card id required')
    const inboxId = await this.spaces.findOrCreateInbox(q, userId)
    const data = itemDataFrom(body)
    await upsertItem(q, inboxId, 'card', body.id, userId, { y: INBOX_XY, z: 1, isRemoved: false, ...data, x: INBOX_XY })
    touched?.add(inboxId)
  }

  // --- helpers ---

  private id (body: JsonObject): string {
    if (!isValidId(body.id)) throw new OpError(400, 'missing or invalid id')
    return body.id
  }

  private stroke (body: JsonObject): unknown[] {
    const stroke = body.stroke
    if (!Array.isArray(stroke) || !stroke.length || !isValidId((stroke[0] as JsonObject)?.id)) {
      throw new OpError(400, 'stroke must be a non-empty array of points with an id')
    }
    return stroke
  }

  private async editable (ctx: Ctx): Promise<string> {
    if (!ctx.spaceId) throw new OpError(400, 'missing spaceId')
    const access = await this.spaces.canEdit(ctx.trx, ctx.userId, ctx.spaceId)
    if (access === 'notFound') throw new OpError(404, 'space not found')
    if (access === 'forbidden') throw new OpError(401, 'not allowed to edit this space')
    ctx.touched.add(ctx.spaceId)
    return ctx.spaceId
  }

  private spaceResult (result: 'ok' | 'notFound' | 'forbidden'): void {
    if (result === 'notFound') throw new OpError(404, 'space not found')
    if (result === 'forbidden') throw new OpError(401, 'not allowed')
  }

  private create (type: ItemType): Handler {
    return async (ctx, body) => {
      const spaceId = await this.editable(ctx)
      await upsertItem(ctx.trx, spaceId, type, this.id(body), ctx.userId, itemDataFrom(body))
    }
  }

  private update (type: ItemType): Handler {
    return async (ctx, body) => {
      const { id: _id, ...rest } = itemDataFrom(body)
      await this.patch(ctx, type, this.id(body), rest)
    }
  }

  private async patch (ctx: Ctx, type: ItemType, id: string, patch: JsonObject): Promise<void> {
    const spaceId = await this.editable(ctx)
    const found = await patchItem(ctx.trx, spaceId, type, id, patch)
    if (!found) throw new OpError(404, `${type} not found`)
  }

  /** Hard delete; deleting something already gone is fine. */
  private remove (type: ItemType): Handler {
    return async (ctx, body) => {
      const spaceId = await this.editable(ctx)
      await deleteItem(ctx.trx, spaceId, type, this.id(body))
    }
  }
}

/**
 * Bodies are objects, except three ops that send arrays. If two array-body
 * ops merge in the client queue the result is an object with numeric keys
 * (OPERATIONS.md rule 7); turn that back into an array-ish object we can read.
 */
export function normalizeBody (body: unknown): JsonObject {
  if (Array.isArray(body)) return { items: body }
  if (!body || typeof body !== 'object') return {}
  const obj = body as JsonObject
  const numericKeys = Object.keys(obj).filter(k => /^\d+$/.test(k))
  if (numericKeys.length) return { ...obj, items: numericKeys.sort((a, b) => Number(a) - Number(b)).map(k => obj[k]) }
  return obj
}
