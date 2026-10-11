import 'reflect-metadata'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INestApplication } from '@nestjs/common'
import { sql } from 'kysely'
import request from 'supertest'
import { createApp } from '../src/app'
import { Config } from '../src/config'
import { createDb, Db } from '../src/db/database'
import { migrate } from '../src/db/migrate'
import { SpacesService } from '../src/spaces/spaces.service'
import { UsersService } from '../src/users/users.service'

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/kinopio_test'

/** A kinopio-client checkout, for its real space fixtures (src/data/*.json). */
export const CLIENT_DIR = process.env.KINOPIO_CLIENT_DIR ?? '/root/kinopio-client'

export function testConfig (overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    databaseUrl: TEST_DATABASE_URL,
    databaseSsl: false,
    allowSignup: 'first-user',
    clientDist: '/nonexistent-client-dist',
    jsonLimit: '50mb',
    signInRateLimit: { max: 1000, windowMs: 60_000 },
    files: { driver: 'local', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kinopio-files-')) },
    uploadSigningSecret: 'test-upload-secret',
    uploadMaxBytes: 5 * 1024 * 1024,
    urlPreview: { allowHosts: [], timeoutMs: 1000 },
    media: {
      workerToken: 'test-worker-token',
      tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kinopio-media-')),
      maxBytes: 5 * 1024 * 1024,
      maxMinutes: 180,
      tmpMaxAgeMs: 60 * 60 * 1000,
      offlineGraceMs: 2 * 60 * 1000
    },
    ...overrides
  }
}

export interface TestContext {
  app: INestApplication
  db: Db
  http: () => ReturnType<typeof request>
  users: UsersService
  close: () => Promise<void>
}

export async function setup (overrides: Partial<Config> = {}): Promise<TestContext> {
  const config = testConfig(overrides)
  const db = createDb(config.databaseUrl, false)
  await migrate(db, () => undefined)
  await sql`truncate users, spaces, items, applied_operations, media_jobs cascade`.execute(db)
  const app = await createApp(config, db, { logger: false })
  const users = new UsersService(db, config, new SpacesService(db))
  return {
    app,
    db,
    http: () => request(app.getHttpServer()),
    users,
    close: async () => { await app.close(); await db.destroy() }
  }
}

export function clientFixture (name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, 'src', 'data', name), 'utf8'))
}

let counter = 0
/** An operation the way the client's addToQueue sends it. */
export function op (name: string, body: Record<string, unknown>, ctx: { spaceId: string, userId: string }) {
  counter++
  return {
    name,
    body: {
      ...body,
      operationId: `op-${Date.now()}-${counter}`,
      spaceId: (body.spaceId as string) ?? ctx.spaceId,
      userId: ctx.userId,
      clientCreatedAt: new Date().toISOString()
    }
  }
}
