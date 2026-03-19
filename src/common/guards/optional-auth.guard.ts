import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { LoggerService } from '../services/logger.service';

/**
 * Like AuthGuard but does not reject unauthenticated requests.
 * Sets request.account if a valid token is present, otherwise leaves it undefined.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  private readonly logger: LoggerService;

  constructor(private readonly loggerService: LoggerService) {
    this.logger = this.loggerService.createChildLogger('OptionalAuthGuard');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers.authorization?.replace('Bearer ', '');

    if (token) {
      try {
        request.account = jwt.verify(token, process.env.JWT_SECRET);
      } catch (e) {
        this.logger.warn('JWT verification failed (optional)', {
          error: e.message,
        });
      }
    } else if (process.env.NURSERY_MODE === 'true') {
      request.account = {
        id: 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96',
        email: 'keeper@crux.garden',
        role: 'keeper',
        grantId: 'nursery-mode-grant',
        exp: Math.floor(Date.now() / 1000) + 86400,
        iat: Math.floor(Date.now() / 1000),
      };
    }

    return true;
  }
}
