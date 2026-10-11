import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { AuthUser, CurrentUser, SignedInGuard } from '../common/auth'
import { badRequest, unauthorized } from '../common/errors'
import { DB, Db, JsonObject } from '../db/database'
import { SpacesService, Viewer } from './spaces.service'

function viewer (user: AuthUser | undefined, collaboratorKey?: string, readOnlyKey?: string): Viewer {
  return { userId: user?.id, collaboratorKey: collaboratorKey || undefined, readOnlyKey: readOnlyKey || undefined }
}

@Controller()
export class SpacesController {
  constructor (
    private readonly spaces: SpacesService,
    @Inject(DB) private readonly db: Db
  ) {}

  // Fixed paths first: `space/:id` would otherwise swallow them.

  /** Other-card and other-space previews (ENDPOINTS.md). Signed-out viewers get public spaces only. */
  @Post('item/multiple')
  @HttpCode(200)
  async otherItems (@CurrentUser() user: AuthUser | undefined, @Body() body: JsonObject) {
    return await this.spaces.otherItems(viewer(user), body?.cardIds, body?.spaceIds)
  }

  @Get('space/inbox')
  @UseGuards(SignedInGuard)
  async inboxId (@CurrentUser() user: AuthUser) {
    return { id: await this.spaces.findOrCreateInbox(this.db, user.id) }
  }

  @Get('user/inbox-space')
  @UseGuards(SignedInGuard)
  async inboxSpace (@CurrentUser() user: AuthUser) {
    const id = await this.spaces.findOrCreateInbox(this.db, user.id)
    return await this.spaces.loadFull(id, { userId: user.id })
  }

  @Get('user/spaces')
  @UseGuards(SignedInGuard)
  async userSpaces (@CurrentUser() user: AuthUser) {
    return await this.spaces.summaries(user.id, false)
  }

  @Get('user/removed-spaces')
  @UseGuards(SignedInGuard)
  async removedSpaces (@CurrentUser() user: AuthUser) {
    return await this.spaces.summaries(user.id, true)
  }

  @Get('space/updated-at/:id')
  async updatedAt (
    @Param('id') id: string,
    @CurrentUser() user: AuthUser | undefined,
    @Headers('space-authorization') collaboratorKey?: string
  ) {
    return await this.spaces.updatedAt(id, viewer(user, collaboratorKey))
  }

  @Get('space/:id/removed-cards')
  @UseGuards(SignedInGuard)
  async removedCards (@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return await this.spaces.removedCards(user.id, id)
  }

  @Get('space/:id')
  async getSpace (
    @Param('id') id: string,
    @CurrentUser() user: AuthUser | undefined,
    @Headers('space-authorization') collaboratorKey?: string,
    @Headers('read-only-authorization') readOnlyKey?: string
  ) {
    return await this.spaces.loadFull(id, viewer(user, collaboratorKey, readOnlyKey))
  }

  @Post('space')
  @HttpCode(200)
  @UseGuards(SignedInGuard)
  async createSpace (@CurrentUser() user: AuthUser, @Body() body: JsonObject) {
    const result = await this.db.transaction().execute(trx => this.spaces.insertFullIfAbsent(trx, user.id, body))
    if (result === 'forbidden') throw unauthorized('space belongs to someone else')
    return { id: body.id, result }
  }

  /** Posted after sign-in/up with every locally cached space, including removed ones. */
  @Post('space/multiple')
  @HttpCode(200)
  @UseGuards(SignedInGuard)
  async createSpaces (@CurrentUser() user: AuthUser, @Body() body: unknown) {
    if (!Array.isArray(body)) throw badRequest('expected an array of spaces')
    const results: Record<string, string> = {}
    for (const space of body as JsonObject[]) {
      try {
        results[String(space?.id)] = await this.db.transaction().execute(trx => this.spaces.insertFullIfAbsent(trx, user.id, space))
      } catch {
        results[String(space?.id)] = 'invalid'
      }
    }
    return { results }
  }

  @Patch('space')
  @UseGuards(SignedInGuard)
  async updateSpace (@CurrentUser() user: AuthUser, @Body() body: JsonObject) {
    const result = await this.spaces.updateSpace(this.db, user.id, body ?? {})
    if (result === 'forbidden') throw unauthorized()
    return { result }
  }

  @Patch('space/restore/:id')
  @UseGuards(SignedInGuard)
  async restore (@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return await this.spaces.restore(user.id, id)
  }
}
