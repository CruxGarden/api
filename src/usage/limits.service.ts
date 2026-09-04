import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { UsageService } from './usage.service';
import { BillingService } from '../billing/billing.service';
import { SETTLEMENT, planById } from './plans';

/**
 * Grace-first enforcement (ADR 0011 amendment 3, ADR 0012):
 * - storage: publishes and sync pushes go through up to the soft limit; between
 *   the soft limit and HARD_FACTOR × plan they still go through (the app shows a
 *   warning from the usage meters); beyond that, new writes are refused with a
 *   402 that names the limit. Nothing is ever unpublished or deleted for limits.
 * - bandwidth and store requests: never block in v1.
 */
export const HARD_FACTOR = 2;

export class OverLimitException extends HttpException {
  constructor(message: string, detail: Record<string, unknown>) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        message,
        error: 'Over plan limit',
        ...detail,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

@Injectable()
export class LimitsService {
  constructor(
    private readonly usage: UsageService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Would storing `incomingBytes` more (replacing `replacingBytes` already
   * counted) push the account past the hard line? Throws 402 if so.
   */
  async assertStorage(
    authorId: string,
    accountId: string | null | undefined,
    incomingBytes: number,
    replacingBytes = 0,
    what = 'publish',
  ): Promise<{
    used: number;
    limit: number;
    softLimit: number;
    warn: boolean;
  }> {
    const planId = await this.billing.planIdFor(accountId);
    const plan = planById(planId);
    const u = await this.usage.forAuthor(
      authorId,
      { plan: planId },
      new Date(),
      accountId ?? undefined,
    );
    const used = u.storageBytes - replacingBytes + incomingBytes;
    const limit = plan.storageBytes;
    const softLimit = Math.round(limit * SETTLEMENT.softLimitFactor);
    const hardLimit = limit * HARD_FACTOR;
    if (limit > 0 && used > hardLimit) {
      throw new OverLimitException(
        `This ${what} would put you at ${fmt(used)} of storage — more than twice the ${fmt(limit)} on the ${plan.name} plan. Free up space or upgrade your plan in Settings.`,
        { limit, used, planId, kind: 'storage' },
      );
    }
    return { used, limit, softLimit, warn: limit > 0 && used > softLimit };
  }
}

function fmt(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}
