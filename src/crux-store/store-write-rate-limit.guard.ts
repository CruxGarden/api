import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { LoggerService } from '../common/services/logger.service';
import { AuthRequest } from '../common/types/interfaces';

export const STORE_WRITES_PER_MINUTE_DEFAULT = 60;
export const STORE_WRITE_RATE_LIMITED =
  'Too many store writes from this account — try again in a minute';

/** Writes per account per minute; `STORE_WRITES_PER_MINUTE_PER_ACCOUNT` overrides. */
export function storeWritesPerMinute(): number {
  const n = parseInt(process.env.STORE_WRITES_PER_MINUTE_PER_ACCOUNT || '', 10);
  return Number.isFinite(n) && n > 0 ? n : STORE_WRITES_PER_MINUTE_DEFAULT;
}

/**
 * A per-account ceiling on Crux Store writes. Every write is attributable
 * (the service refuses unsigned ones), so this counts by account — the
 * global throttler already counts by IP. Runs after `OptionalAuthGuard`, which
 * puts the account on the request; a request without one is left to the
 * service's 401. Counts live in the throttler's storage (in-process by
 * default), one bucket per account; a hit expires after a minute and an
 * account over the limit is blocked for a minute.
 */
const WINDOW_MS = 60_000;
@Injectable()
export class StoreWriteRateLimitGuard implements CanActivate {
  private readonly logger: LoggerService;

  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('StoreWriteRateLimitGuard');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const accountId = req.account?.id;
    if (!accountId) return true;

    const limit = storeWritesPerMinute();
    const { totalHits, isBlocked } = await this.storage.increment(
      `store-writes:${accountId}`,
      WINDOW_MS,
      limit,
      WINDOW_MS,
      'store-writes',
    );
    if (isBlocked || totalHits > limit) {
      this.logger.warn('Store write rate limit hit', {
        accountId,
        cruxId: req.params?.cruxId,
        limit,
      });
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: STORE_WRITE_RATE_LIMITED,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
