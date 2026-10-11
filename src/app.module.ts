import { DynamicModule, Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { Config, CONFIG } from './config'
import { JsonErrorFilter } from './common/errors'
import { DB, Db } from './db/database'
import { FILE_STORAGE, FileStorage } from './files/storage'
import { CardEvents } from './media/card-events'
import { MediaController, WorkerController, WorkerGuard } from './media/media.controller'
import { MediaService } from './media/media.service'
import { WorkerHub } from './media/worker-hub'
import { UploadsController } from './files/uploads.controller'
import { MetaController } from './meta/meta.controller'
import { OperationsController } from './operations/operations.controller'
import { OperationsService } from './operations/operations.service'
import { PreviewsController } from './previews/previews.controller'
import { Relay } from './realtime/relay'
import { SpacesController } from './spaces/spaces.controller'
import { SpacesService } from './spaces/spaces.service'
import { UsersController } from './users/users.controller'
import { UsersService } from './users/users.service'

@Module({})
export class AppModule {
  static register (config: Config, db: Db, storage: FileStorage): DynamicModule {
    return {
      module: AppModule,
      controllers: [MetaController, UsersController, SpacesController, OperationsController, UploadsController, PreviewsController, MediaController, WorkerController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DB, useValue: db },
        { provide: FILE_STORAGE, useValue: storage },
        { provide: APP_FILTER, useClass: JsonErrorFilter },
        SpacesService,
        UsersService,
        OperationsService,
        Relay,
        CardEvents,
        WorkerHub,
        WorkerGuard,
        MediaService
      ]
    }
  }
}
