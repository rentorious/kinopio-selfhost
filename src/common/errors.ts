import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common'
import type { Response } from 'express'

/**
 * Error bodies are always JSON with the status inside the body, because the
 * client's sign-in/up flows read `status` and `type` from the body, not the
 * HTTP status (SPEC.md §4).
 */
export class ApiError extends HttpException {
  constructor (status: number, message: string, extra: Record<string, unknown> = {}) {
    super({ status, message, ...extra }, status)
  }
}

export const notFound = (message = 'not found') => new ApiError(404, message)
export const unauthorized = (message = 'not allowed') => new ApiError(401, message)
export const badRequest = (message = 'bad request') => new ApiError(400, message)

@Catch()
export class JsonErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error')

  catch (exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>()
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const body = exception.getResponse()
      if (typeof body === 'object' && body !== null && 'status' in body) {
        res.status(status).json(body)
      } else {
        const message = typeof body === 'string' ? body : (body as { message?: string })?.message ?? exception.message
        res.status(status).json({ status, message })
      }
      return
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception))
    res.status(500).json({ status: 500, message: 'internal error' })
  }
}
