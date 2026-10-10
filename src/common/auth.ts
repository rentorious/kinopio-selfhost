import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { Db } from '../db/database'
import { unauthorized } from './errors'

export interface AuthUser {
  id: string
  email: string | null
}

export interface AuthedRequest extends Request {
  user?: AuthUser
}

/**
 * Resolve `Authorization: <apiKey>` (raw key, no Bearer prefix) to a user.
 * Missing or unknown key = anonymous. `User-Id` and body userIds are never
 * trusted for identity.
 */
export function authMiddleware (db: Db) {
  return async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization')?.trim()
      if (header) {
        const row = await db.selectFrom('users')
          .select(['id', 'email'])
          .where('api_key', '=', header)
          .executeTakeFirst()
        if (row) req.user = row
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user
})

@Injectable()
export class SignedInGuard implements CanActivate {
  canActivate (ctx: ExecutionContext): boolean {
    if (!ctx.switchToHttp().getRequest<AuthedRequest>().user) throw unauthorized('sign in required')
    return true
  }
}
