import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { LoggerService } from '../services/logger.service';

interface ErrorResponse {
  statusCode: number;
  timestamp: string;
  path: string;
  method: string;
  message: string | string[];
  error?: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger: LoggerService;

  constructor(private readonly loggerService: LoggerService) {
    this.logger = this.loggerService.createChildLogger('HttpExceptionFilter');
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const conflict = isUniqueViolation(exception);
    const status = conflict
      ? HttpStatus.CONFLICT
      : exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const errorResponse: ErrorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message: conflict
        ? 'A record with these values already exists'
        : status >= 500
          ? 'Internal server error'
          : this.getErrorMessage(exception),
    };

    if (status < 500) {
      errorResponse.error = conflict
        ? 'Conflict'
        : this.getErrorName(exception);
    }

    // Log the error
    this.logError(exception, request, status);

    response.status(status).json(errorResponse);
  }

  private getErrorMessage(exception: unknown): string | string[] {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'object' && 'message' in response) {
        return (response as any).message;
      }
      return exception.message;
    }

    if (exception instanceof Error) {
      return exception.message;
    }

    return 'Internal server error';
  }

  private getErrorName(exception: unknown): string {
    if (exception instanceof HttpException) {
      return exception.constructor.name.replace('Exception', '');
    }

    if (exception instanceof Error) {
      return exception.name;
    }

    return 'Error';
  }

  private logError(exception: unknown, request: Request, status: number) {
    const message = this.getErrorMessage(exception);
    const context = {
      path: request.url,
      method: request.method,
      statusCode: status,
      ip: request.ip,
      userAgent: request.get('user-agent'),
    };

    if (status >= 500) {
      this.logger.error(
        `Server Error: ${message}`,
        exception instanceof Error ? exception : undefined,
        context,
      );
    } else if (status >= 400) {
      this.logger.warn(`Client Error: ${message}`, context);
    }
  }
}

/** Drivers expose stable codes; never infer a conflict from database text. */
function isUniqueViolation(exception: unknown): boolean {
  const seen = new Set<unknown>();
  let current = exception;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (
      'code' in current &&
      [
        '23505',
        'SQLITE_CONSTRAINT_UNIQUE',
        'SQLITE_CONSTRAINT_PRIMARYKEY',
      ].includes(String(current.code))
    )
      return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}
