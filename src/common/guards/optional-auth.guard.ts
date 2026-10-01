import { Optional } from '@nestjs/common';
import { DbService } from '../services/db.service';
import { activeTokenAccount } from './token-account';
import { ForbiddenException } from '@nestjs/common';
import { isAccountOrigin } from './account-origin.guard';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { LoggerService } from '../services/logger.service';
import { nurseryAccount } from './nursery-account';

/**
 * Like AuthGuard but does not reject unauthenticated requests.
 * Sets request.account if a valid token is present, otherwise leaves it undefined.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  private readonly logger: LoggerService;

  constructor(
    private readonly loggerService: LoggerService,
    @Optional() private readonly db?: DbService,
  ) {
    this.logger = this.loggerService.createChildLogger('OptionalAuthGuard');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers.authorization?.replace('Bearer ', '');

    if (token && !isAccountOrigin(request.headers.origin))
      throw new ForbiddenException(
        'Published pages require visitor credentials',
      );

    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        if (await activeTokenAccount(this.db, payload))
          request.account = payload;
      } catch (e) {
        this.logger.warn('JWT verification failed (optional)', {
          error: e.message,
        });
      }
    } else {
      request.account = nurseryAccount();
    }

    return true;
  }
}
