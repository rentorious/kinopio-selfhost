import 'reflect-metadata'
import { loadConfig } from '../config'
import { createDb } from '../db/database'
import { migrate } from '../db/migrate'
import { SpacesService } from '../spaces/spaces.service'
import { UsersService } from '../users/users.service'

/**
 * Create an account without the sign-up UI, including its Inbox.
 *   npm run create-user -- --email me@example.com --password '…' [--name Ognjen]
 * On Railway: `railway run npm run create-user -- …` or the service shell.
 */
async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (!args.email || !args.password) {
    console.error('usage: create-user --email <email> --password <password> [--name <name>]')
    process.exit(2)
  }
  const config = loadConfig()
  const db = createDb(config.databaseUrl, config.databaseSsl)
  try {
    await migrate(db, () => undefined)
    const users = new UsersService(db, config, new SpacesService(db))
    const prefs = args.name ? { name: args.name } : {}
    const user = await users.createUser({ email: args.email, password: args.password, prefs, withInbox: true })
    console.log(`created ${user.email} (id ${user.id})`)
  } finally {
    await db.destroy()
  }
}

function parseArgs (argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i])
    if (!m) continue
    out[m[1]] = m[2] ?? argv[++i] ?? ''
  }
  return out
}

main().catch(err => {
  console.error(err?.response?.message ?? err)
  process.exit(1)
})
