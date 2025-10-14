import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { LoggerService } from '../services/logger.service';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger: LoggerService;

  constructor(private readonly loggerService: LoggerService) {
    this.logger = this.loggerService.createChildLogger('AuthGuard');
  }

  private generateNurseryModeAccount() {
    return {
      id: 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96',
      email: 'keeper@crux.garden',
      role: 'keeper',
      grantId: 'nursery-mode-grant',
      exp: Math.floor(Date.now() / 1000) + 86400, // 24 hours from now
      iat: Math.floor(Date.now() / 1000),
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers.authorization?.replace('Bearer ', '');

    if (token) {
      let payload = null;
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
      } catch (e) {
        this.logger.warn('JWT verification failed', {
          error: e.message,
          tokenPrefix: token.substring(0, 10) + '...',
        });
      }
      if (!payload)
        throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
      request.account = payload;
      return true;
    } else {
      if (process.env.NURSERY_MODE === 'true') {
        this.logger.debug(
          'NURSERY_MODE enabled - using Keeper account for unauthenticated request',
        );
        request.account = this.generateNurseryModeAccount();
        return true;
      } else {
        throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
      }
    }
  }
}
