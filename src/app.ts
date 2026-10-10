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
import { stubRouter } from './stubs/stubs'

/**
 * Build the app without listening, so tests can drive it with supertest.
 * Request order: JSON body parsing → auth → stub table → Nest routes (/api)
 * → client static files and SPA fallback.
 */
export async function createApp (config: Config, db: Db, opts: { logger?: false } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, db), {
    bodyParser: false,
    logger: opts.logger === false ? false : ['log', 'warn', 'error']
  })
  app.set('trust proxy', true)
  app.disable('x-powered-by')
  app.use(express.json({ limit: config.jsonLimit }))
  app.use('/api', authMiddleware(db))
  app.use('/api', stubRouter())
  app.use(clientStatic(config.clientDist))
  app.setGlobalPrefix('api')
  await app.init()
  return app
}
