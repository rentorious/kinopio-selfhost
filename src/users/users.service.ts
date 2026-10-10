import { Inject, Injectable } from '@nestjs/common'
import { hash, verify } from '@node-rs/argon2'
import { Kysely, sql } from 'kysely'
import { CONFIG, Config } from '../config'
import { ApiError } from '../common/errors'
import { isValidId, nanoid, newApiKey } from '../common/ids'
import { Database, DB, Db, JsonObject, json } from '../db/database'
import { SpacesService } from '../spaces/spaces.service'
import { prefsFrom, userObject, UserRow } from './user-data'

type Q = Kysely<Database>

const USER_COLUMNS = ['id', 'email', 'api_key', 'prefs', 'cards_created_count', 'cards_created_count_raw', 'created_at', 'updated_at'] as const

@Injectable()
export class UsersService {
  constructor (
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    private readonly spaces: SpacesService
  ) {}

  private async userRow (q: Q, id: string): Promise<UserRow | undefined> {
    return await q.selectFrom('users').select([...USER_COLUMNS]).where('id', '=', id).executeTakeFirst()
  }

  /**
   * Create a user. With `withInbox`, also create their Inbox and point
   * lastSpaceId at it: needed for accounts made outside the client (CLI),
   * whose first sign-in would otherwise land on a deleted local space.
   */
  async createUser (input: { email: string, password: string, id?: string, prefs?: JsonObject, withInbox: boolean }): Promise<JsonObject> {
    const email = normalizeEmail(input.email)
    if (!email) throw new ApiError(400, 'email required')
    if (!input.password) throw new ApiError(400, 'password required')
    const passwordHash = await hash(input.password)
    return await this.db.transaction().execute(async trx => {
      const taken = await trx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()
      if (taken) throw new ApiError(409, 'an account with this email already exists', { type: 'unique violation' })
      let id = isValidId(input.id) ? input.id : nanoid()
      if (await trx.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst()) id = nanoid()
      const prefs = { ...(input.prefs ?? {}) }
      await trx.insertInto('users').values({
        id, email, password_hash: passwordHash, api_key: newApiKey(), prefs: json(prefs)
      }).execute()
      if (input.withInbox) {
        const inboxId = await this.spaces.findOrCreateInbox(trx, id)
        if (!prefs.lastSpaceId) {
          await trx.updateTable('users').set({ prefs: sql`prefs || ${json({ lastSpaceId: inboxId })}` }).where('id', '=', id).execute()
        }
      }
      const row = await this.userRow(trx, id)
      return userObject(row!)
    })
  }

  async signUpAllowed (): Promise<boolean> {
    if (this.config.allowSignup === 'true') return true
    if (this.config.allowSignup === 'false') return false
    const row = await this.db.selectFrom('users').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()
    return row.n === 0
  }

  /**
   * POST /user/sign-up. The body is the client's whole local user state plus
   * email/password/sessionToken. Keep its id (its local spaces reference it)
   * and its preferences. No Inbox here: the client posts its own local spaces
   * right after, and its lastSpaceId points at one of them.
   */
  async signUp (body: JsonObject): Promise<JsonObject> {
    if (!(await this.signUpAllowed())) throw new ApiError(403, 'sign up is closed on this server')
    return await this.createUser({
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
      id: typeof body.id === 'string' ? body.id : undefined,
      prefs: prefsFrom(body),
      withInbox: false
    })
  }

  async signIn (emailInput: unknown, password: unknown): Promise<JsonObject> {
    const email = normalizeEmail(String(emailInput ?? ''))
    const row = email
      ? await this.db.selectFrom('users').select(['id', 'password_hash']).where('email', '=', email).executeTakeFirst()
      : undefined
    const ok = !!row?.password_hash && typeof password === 'string' && password.length > 0 &&
      await verify(row.password_hash, password).catch(() => false)
    if (!ok || !row) throw new ApiError(401, 'incorrect email or password')
    return await this.currentUser(row.id)
  }

  /**
   * The user object for sign-in and GET /user, with a lastSpaceId that points
   * at a space that exists. The client merges this over its local state, so a
   * missing or stale lastSpaceId would leave it on a space the server can't
   * serve (SPEC.md §6.1).
   */
  async currentUser (userId: string): Promise<JsonObject> {
    const row = await this.userRow(this.db, userId)
    if (!row) throw new ApiError(401, 'unknown user')
    return userObject(row, { lastSpaceId: await this.validLastSpaceId(row) })
  }

  private async validLastSpaceId (row: UserRow): Promise<string> {
    const wanted = row.prefs.lastSpaceId
    if (isValidId(wanted)) {
      const space = await this.db.selectFrom('spaces').select(['owner_id', 'privacy', 'is_removed'])
        .where('id', '=', wanted).executeTakeFirst()
      if (space && !space.is_removed && (space.owner_id === row.id || space.privacy !== 'private')) return wanted
    }
    const latest = await this.db.selectFrom('spaces').select('id')
      .where('owner_id', '=', row.id).where('is_removed', '=', false)
      .orderBy('updated_at', 'desc').executeTakeFirst()
    return latest?.id ?? await this.spaces.findOrCreateInbox(this.db, row.id)
  }

  /** updateUser operation: merge allowed keys into prefs. */
  async updatePrefs (q: Q, userId: string, body: JsonObject): Promise<void> {
    const patch = prefsFrom(body)
    if (Object.keys(patch).length === 0) return
    await q.updateTable('users')
      .set({ prefs: sql`prefs || ${json(patch)}`, updated_at: sql`now()` })
      .where('id', '=', userId)
      .execute()
  }

  async addCardsCreated (q: Q, userId: string, delta: unknown, raw: boolean): Promise<void> {
    const n = Number(delta)
    if (!Number.isFinite(n) || n === 0) return
    const step = Math.trunc(n)
    if (raw) {
      await q.updateTable('users').set({ cards_created_count_raw: sql`greatest(cards_created_count_raw + ${step}, 0)` }).where('id', '=', userId).execute()
    } else {
      await q.updateTable('users').set({ cards_created_count: sql`greatest(cards_created_count + ${step}, 0)` }).where('id', '=', userId).execute()
    }
  }
}

function normalizeEmail (email: string): string {
  return email.trim().toLowerCase()
}
