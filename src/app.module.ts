import { DynamicModule, Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { Config, CONFIG } from './config'
import { JsonErrorFilter } from './common/errors'
import { DB, Db } from './db/database'
import { MetaController } from './meta/meta.controller'
import { OperationsController } from './operations/operations.controller'
import { OperationsService } from './operations/operations.service'
import { SpacesController } from './spaces/spaces.controller'
import { SpacesService } from './spaces/spaces.service'
import { UsersController } from './users/users.controller'
import { UsersService } from './users/users.service'

@Module({})
export class AppModule {
  static register (config: Config, db: Db): DynamicModule {
    return {
      module: AppModule,
      controllers: [MetaController, UsersController, SpacesController, OperationsController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DB, useValue: db },
        { provide: APP_FILTER, useClass: JsonErrorFilter },
        SpacesService,
        UsersService,
        OperationsService
      ]
    }
  }
}
