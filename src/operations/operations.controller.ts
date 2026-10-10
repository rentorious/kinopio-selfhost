import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import { AuthUser, CurrentUser, SignedInGuard } from '../common/auth'
import { ApiError } from '../common/errors'
import { DB, Db, JsonObject } from '../db/database'
import { OpError, OperationsService } from './operations.service'

@Controller()
export class OperationsController {
  constructor (
    private readonly operations: OperationsService,
    @Inject(DB) private readonly db: Db
  ) {}

  /**
   * The write path (OPERATIONS.md). Success: 200 {}. Any failed op: 400 with
   * { operations, errors: [{ status }] }, which the client parses; 400/401/404
   * are non-critical to it, anything else shows "could not save".
   */
  @Post('operations')
  @HttpCode(200)
  @UseGuards(SignedInGuard)
  async apply (@CurrentUser() user: AuthUser, @Body() body: unknown) {
    try {
      const result = await this.operations.apply(user.id, body)
      if (result.errors.length) {
        throw new ApiError(400, 'some operations failed', { operations: [], errors: result.errors })
      }
      return {}
    } catch (err) {
      if (err instanceof OpError) throw new ApiError(err.status, err.message, { operations: [], errors: [{ status: err.status, message: err.message }] })
      throw err
    }
  }

  /** Browser extension / Add page. */
  @Post('card/to-inbox')
  @HttpCode(200)
  @UseGuards(SignedInGuard)
  async toInbox (@CurrentUser() user: AuthUser, @Body() body: JsonObject) {
    try {
      await this.db.transaction().execute(trx => this.operations.addCardToInbox(trx, user.id, body ?? {}))
      return {}
    } catch (err) {
      if (err instanceof OpError) throw new ApiError(err.status, err.message)
      throw err
    }
  }
}
