import { DbService } from '../common/services/db.service';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  ForbiddenException,
} from '@nestjs/common';
import { OptionalAuthGuard } from '../common/guards/optional-auth.guard';
import { LoggerService } from '../common/services/logger.service';
import { AuthRequest } from '../common/types/interfaces';
import { PublishedAuthService } from './published-auth.service';
import { isAccountOrigin } from '../common/guards/account-origin.guard';

/** Only explicitly marked Store/Function routes accept published credentials. */
@Injectable()
export class VisitorAuthGuard implements CanActivate {
  constructor(
    private readonly published: PublishedAuthService,
    private readonly logger: LoggerService,
    @Optional() private readonly db?: DbService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (token?.startsWith('pv_')) {
      const session = await this.published.visitor(
        token,
        String(req.params.cruxId),
        req.headers.origin,
      );
      req.publishedVisitor = {
        id: session.visitor.id,
        accountId: session.accountId,
      };
      return true;
    }
    if (token && !isAccountOrigin(req.headers.origin))
      throw new ForbiddenException(
        'Published pages require visitor credentials',
      );
    return new OptionalAuthGuard(this.logger, this.db).canActivate(context);
  }
}
