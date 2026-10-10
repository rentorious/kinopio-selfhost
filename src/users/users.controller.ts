import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { CONFIG, Config } from '../config'
import { AuthUser, CurrentUser, SignedInGuard } from '../common/auth'
import { ApiError } from '../common/errors'
import { RateLimiter } from '../common/rate-limit'
import { JsonObject } from '../db/database'
import { UsersService } from './users.service'

@Controller()
export class UsersController {
  private readonly limiter: RateLimiter

  constructor (
    private readonly users: UsersService,
    @Inject(CONFIG) config: Config
  ) {
    this.limiter = new RateLimiter(config.signInRateLimit.max, config.signInRateLimit.windowMs)
  }

  /** Sign-up spam token. Fire-and-forget on the client; nothing to do. */
  @Post('session-token/create')
  @HttpCode(200)
  sessionToken () {
    return {}
  }

  @Post('user/sign-in')
  @HttpCode(200)
  async signIn (@Body() body: JsonObject, @Req() req: Request) {
    this.checkRate(req, body?.email)
    return await this.users.signIn(body?.email, body?.password)
  }

  @Post('user/sign-up')
  @HttpCode(200)
  async signUp (@Body() body: JsonObject, @Req() req: Request) {
    this.checkRate(req, body?.email)
    return await this.users.signUp(body ?? {})
  }

  @Get('user')
  @UseGuards(SignedInGuard)
  async me (@CurrentUser() user: AuthUser) {
    return await this.users.currentUser(user.id)
  }

  /** The client reads `status: 429` from the JSON body. */
  private checkRate (req: Request, email: unknown) {
    const keys = [`ip:${req.ip}`, `email:${String(email ?? '').toLowerCase()}`]
    for (const key of keys) {
      if (!this.limiter.attempt(key)) throw new ApiError(429, 'too many attempts, try again later')
    }
  }
}
