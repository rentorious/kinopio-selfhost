import { Injectable } from '@nestjs/common'
import { EventEmitter } from 'node:events'

/**
 * Lets the media module hear about cards being removed (deleting a media
 * summary's placeholder card cancels its job) without the operations module
 * depending on it.
 */
@Injectable()
export class CardEvents extends EventEmitter {
  cardRemoved (spaceId: string, cardId: string): void {
    this.emit('cardRemoved', spaceId, cardId)
  }
}
