import { Injectable } from '@nestjs/common';

export enum CustomLogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  VERBOSE = 4,
}

export interface LogContext {
  [key: string]: any;
}

@Injectable()
export class LoggerService {
  private readonly logLevel: CustomLogLevel;
  private serviceName: string;

  constructor() {
    this.serviceName = 'Application';
    this.logLevel = this.getLogLevelFromEnv();
  }

  private getLogLevelFromEnv(): CustomLogLevel {
    const envLevel = process.env.LOG_LEVEL?.toUpperCase();
    switch (envLevel) {
      case 'ERROR':
        return CustomLogLevel.ERROR;
      case 'WARN':
        return CustomLogLevel.WARN;
      case 'INFO':
        return CustomLogLevel.INFO;
      case 'DEBUG':
        return CustomLogLevel.DEBUG;
      case 'VERBOSE':
        return CustomLogLevel.VERBOSE;
      default:
        return process.env.NODE_ENV === 'production'
          ? CustomLogLevel.INFO
          : CustomLogLevel.DEBUG;
    }
  }

  private shouldLog(level: CustomLogLevel): boolean {
    return level <= this.logLevel;
  }

  private formatMessage(
    level: string,
    message: string,
    context?: LogContext,
    service?: string,
  ): string {
    const timestamp = new Date().toISOString();
    const serviceContext = service || this.serviceName;

    const baseLog = {
      timestamp,
      level,
      service: serviceContext,
      message,
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
    };

    if (process.env.NODE_ENV === 'production') {
      return JSON.stringify(baseLog);
    } else {
      const colorizedLevel = this.colorizeLevel(level);
      const contextStr =
        context && Object.keys(context).length > 0
          ? ` ${JSON.stringify(context)}`
          : '';
      return `[${timestamp}] ${colorizedLevel} [${serviceContext}] ${message}${contextStr}`;
    }
  }

  private colorizeLevel(level: string): string {
    const colors = {
      ERROR: '\x1b[91m', // Light red (muted)
      WARN: '\x1b[93m', // Light yellow (muted)
      INFO: '\x1b[94m', // Light blue (muted)
      DEBUG: '\x1b[95m', // Light magenta (muted)
      VERBOSE: '\x1b[90m', // Dark gray (muted)
    };
    const reset = '\x1b[0m';
    const color = colors[level as keyof typeof colors] || '';
    return `${color}${level}${reset}`;
  }

  error(
    message: string,
    error?: Error,
    context?: LogContext,
    service?: string,
  ): void {
    if (!this.shouldLog(CustomLogLevel.ERROR)) return;

    const errorContext = {
      ...context,
      ...(error && {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      }),
    };

    console.error(this.formatMessage('ERROR', message, errorContext, service));
  }

  warn(message: string, context?: LogContext, service?: string): void {
    if (!this.shouldLog(CustomLogLevel.WARN)) return;
    console.warn(this.formatMessage('WARN', message, context, service));
  }

  info(message: string, context?: LogContext, service?: string): void {
    if (!this.shouldLog(CustomLogLevel.INFO)) return;
    console.info(this.formatMessage('INFO', message, context, service));
  }

  debug(message: string, context?: LogContext, service?: string): void {
    if (!this.shouldLog(CustomLogLevel.DEBUG)) return;
    console.debug(this.formatMessage('DEBUG', message, context, service));
  }

  verbose(message: string, context?: LogContext, service?: string): void {
    if (!this.shouldLog(CustomLogLevel.VERBOSE)) return;
    console.log(this.formatMessage('VERBOSE', message, context, service));
  }

  log(message: string, context?: LogContext, service?: string): void {
    this.info(message, context, service);
  }

  createChildLogger(serviceName: string): LoggerService {
    const childLogger = new LoggerService();
    childLogger.serviceName = serviceName;
    return childLogger;
  }

  logHttpRequest(
    method: string,
    url: string,
    statusCode: number,
    responseTime: number,
    userAgent?: string,
    userId?: string,
  ): void {
    const context: LogContext = {
      method,
      url,
      statusCode,
      responseTime: `${responseTime}ms`,
      ...(userAgent && { userAgent }),
      ...(userId && { userId }),
    };

    const level =
      statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    const message = `${method} ${url} ${statusCode} - ${responseTime}ms`;

    switch (level) {
      case 'error':
        this.error(message, undefined, context, 'HTTP');
        break;
      case 'warn':
        this.warn(message, context, 'HTTP');
        break;
      default:
        this.info(message, context, 'HTTP');
    }
  }

  logDatabaseQuery(
    query: string,
    executionTime: number,
    rowCount?: number,
    error?: Error,
  ): void {
    const context: LogContext = {
      query: query.length > 200 ? `${query.substring(0, 200)}...` : query,
      executionTime: `${executionTime}ms`,
      ...(rowCount !== undefined && { rowCount }),
    };

    if (error) {
      this.error('Database query failed', error, context, 'DATABASE');
    } else if (executionTime > 1000) {
      this.warn('Slow database query detected', context, 'DATABASE');
    } else {
      this.debug('Database query executed', context, 'DATABASE');
    }
  }
}
