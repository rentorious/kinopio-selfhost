import { ColumnType, Generated, Kysely, PostgresDialect, RawBuilder, sql } from 'kysely'
import { Pool } from 'pg'

// jsonb columns come back parsed; always write them through json() below,
// because node-pg turns JS arrays into Postgres array literals, not JSON.
// Write types are loose so raw SQL expressions (data || patch) type-check.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json<T> = ColumnType<T, any, any>
export type JsonObject = Record<string, unknown>

export interface UsersTable {
  id: string
  email: string | null
  password_hash: string | null
  api_key: string
  prefs: Json<JsonObject>
  cards_created_count: Generated<number>
  cards_created_count_raw: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface SpacesTable {
  id: string
  owner_id: string
  name: string
  privacy: string
  collaborator_key: string
  read_only_key: string
  is_removed: Generated<boolean>
  removed_by_user_id: string | null
  edited_at: Date | null
  edited_by_user_id: string | null
  meta: Json<JsonObject>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type ItemType = 'card' | 'connection' | 'box' | 'list' | 'line' | 'tag' | 'drawingStroke'

export interface ItemsTable {
  space_id: string
  type: ItemType
  id: string
  user_id: string | null
  data: Json<unknown>
  seq: Generated<string>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface AppliedOperationsTable {
  operation_id: string
  applied_at: Generated<Date>
}

export interface Database {
  users: UsersTable
  spaces: SpacesTable
  items: ItemsTable
  applied_operations: AppliedOperationsTable
}

export type Db = Kysely<Database>

export const DB = Symbol('DB')

export function createDb (databaseUrl: string, ssl: boolean): Db {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 10
  })
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

/** Serialize a value for a jsonb column. */
export function json<T> (value: T): RawBuilder<T> {
  return sql<T>`${JSON.stringify(value ?? null)}::jsonb`
}
