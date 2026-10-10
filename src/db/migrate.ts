import fs from 'node:fs'
import path from 'node:path'
import { sql } from 'kysely'
import { Db, createDb } from './database'
import { loadConfig } from '../config'

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')
const LOCK_ID = 7_234_101 // arbitrary, shared by every instance of this app

/**
 * Apply every .sql file in ./migrations that hasn't run yet, in name order,
 * each in its own transaction. An advisory lock keeps two booting instances
 * from racing.
 */
export async function migrate (db: Db, log: (msg: string) => void = console.log): Promise<string[]> {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  const applied: string[] = []
  await db.connection().execute(async conn => {
    await sql`select pg_advisory_lock(${LOCK_ID})`.execute(conn)
    try {
      await sql`create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`.execute(conn)
      const done = await sql<{ name: string }>`select name from schema_migrations`.execute(conn)
      const doneNames = new Set(done.rows.map(r => r.name))
      for (const file of files) {
        if (doneNames.has(file)) continue
        const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
        await conn.transaction().execute(async trx => {
          await sql.raw(body).execute(trx)
          await sql`insert into schema_migrations (name) values (${file})`.execute(trx)
        })
        log(`migration applied: ${file}`)
        applied.push(file)
      }
    } finally {
      await sql`select pg_advisory_unlock(${LOCK_ID})`.execute(conn)
    }
  })
  return applied
}

if (require.main === module) {
  const config = loadConfig()
  const db = createDb(config.databaseUrl, config.databaseSsl)
  migrate(db)
    .then(applied => console.log(applied.length ? `applied ${applied.length}` : 'up to date'))
    .finally(() => db.destroy())
    .catch(err => { console.error(err); process.exit(1) })
}
