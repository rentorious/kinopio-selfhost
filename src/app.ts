import 'reflect-metadata'
import { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import express from 'express'
import { AppModule } from './app.module'
import { authMiddleware } from './common/auth'
import { clientStatic } from './common/client-static'
import { Config } from './config'
import { Db } from './db/database'
import { filesRouter } from './files/files-router'
import { createStorage, FileStorage } from './files/storage'
import { stubRouter } from './stubs/stubs'
import { WorkerHub } from './media/worker-hub'
import { Relay } from './realtime/relay'
import { routeUpgrades } from './realtime/upgrades'

/**
 * Build the app without listening, so tests can drive it with supertest.
 * Request order: JSON body parsing → auth → stub table → /files → Nest
 * routes (/api) → client static files and SPA fallback. Websocket upgrades
 * are routed by path (realtime/upgrades.ts).
 */
export async function createApp (config: Config, db: Db, opts: { logger?: false, storage?: FileStorage } = {}): Promise<INestApplication> {
  const storage = opts.storage ?? createStorage(config.files)
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, db, storage), {
    bodyParser: false,
    logger: opts.logger === false ? false : ['log', 'warn', 'error']
  })
  app.set('trust proxy', true)
  app.disable('x-powered-by')
  app.use(express.json({ limit: config.jsonLimit }))
  app.use('/api', authMiddleware(db))
  app.use('/api', stubRouter())
  app.use('/files', filesRouter(storage))
  app.use(clientStatic(config.clientDist))
  app.setGlobalPrefix('api')
  await app.init()
  routeUpgrades(app.getHttpServer(), { '/api/ws': app.get(Relay).wss, '/api/worker/ws': app.get(WorkerHub).wss })
  return app
}
