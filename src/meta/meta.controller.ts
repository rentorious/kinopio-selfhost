import { Controller, Get, Header, Param } from '@nestjs/common'
import { notFound } from '../common/errors'
import { dateCardSvg } from '../stubs/stubs'

@Controller()
export class MetaController {
  /** Client status check: any truthy JSON means "online". */
  @Get()
  status () {
    return { status: 'ok' }
  }

  /** Read unguarded as serverDate.date; an error throws in the client. */
  @Get('meta/date')
  date () {
    return { date: new Date().toISOString() }
  }

  /** Image for the date card on new spaces; GET /space/date-image points here. */
  @Get('date-card/:file')
  @Header('Content-Type', 'image/svg+xml')
  @Header('Cache-Control', 'public, max-age=86400')
  dateCard (@Param('file') file: string) {
    const svg = dateCardSvg(file.replace(/\.svg$/, ''))
    if (!svg) throw notFound()
    return svg
  }
}
