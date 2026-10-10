import { Logger } from '@nestjs/common'
import { createApp } from './app'
import { loadConfig } from './config'
import { createDb } from './db/database'
import { migrate } from './db/migrate'

async function main () {
  const log = new Logger('Boot')
  const config = loadConfig()
  const db = createDb(config.databaseUrl, config.databaseSsl)
  await migrate(db, msg => log.log(msg))
  const app = await createApp(config, db)
  app.enableShutdownHooks()
  await app.listen(config.port, '0.0.0.0')
  log.log(`listening on :${config.port} (client: ${config.clientDist}, sign-up: ${config.allowSignup})`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
