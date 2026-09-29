import { ForbiddenException } from '@nestjs/common';
import { isAccountOrigin } from './account-origin.guard';
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { LoggerService } from '../services/logger.service';
import { nurseryAccount } from './nursery-account';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger: LoggerService;

  constructor(private readonly loggerService: LoggerService) {
    this.logger = this.loggerService.createChildLogger('AuthGuard');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers.authorization?.replace('Bearer ', '');

    if (token && !isAccountOrigin(request.headers.origin))
      throw new ForbiddenException(
        'Published pages require visitor credentials',
      );

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
    }
    const account = nurseryAccount();
    if (!account)
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    request.account = account;
    return true;
  }
}
