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
  stack?: string;
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

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const errorResponse: ErrorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message: this.getErrorMessage(exception),
    };

    // Add error name for non-500 errors
    if (status !== HttpStatus.INTERNAL_SERVER_ERROR) {
      errorResponse.error = this.getErrorName(exception);
    }

    // Add stack trace in development
    if (process.env.NODE_ENV !== 'production' && exception instanceof Error) {
      errorResponse.stack = exception.stack;
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
