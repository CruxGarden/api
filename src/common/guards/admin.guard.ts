import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { isAdmin } from '../helpers/role-helpers';
import { AuthRequest } from '../types/interfaces';

/** Use after AuthGuard on host-administration routes. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (!isAdmin(request.account?.role))
      throw new ForbiddenException('Admin access required');
    return true;
  }
}
