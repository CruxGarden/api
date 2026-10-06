import type { LoggerService } from '../common/services/logger.service';
import type { NotificationsService } from '../usage/notifications.service';
import { PLANS } from '../usage/plans';
import { InferenceRepository, usageTotals } from './inference.repository';
import { ALLOWANCES, MIN_USEFUL_OUTPUT, SONNET, reservation } from './policy';

/** The smallest included request: no context, the minimum useful reply. */
export const MINIMUM_REQUEST_MICRODOLLARS = reservation(
  SONNET,
  0,
  MIN_USEFUL_OUTPUT,
);

/**
 * After a settlement: hand the rolling 30-day window to the usage notices
 * (ADR 0082). Usage only changes at settlement, so this is the only trigger.
 * Never throws; a notice is never worth failing a request over.
 */
export async function notifyIncludedAllowance(
  repo: InferenceRepository,
  notifications: NotificationsService | undefined,
  logger: LoggerService,
  accountId: string,
  planId: string,
  now = new Date(),
): Promise<void> {
  const limit = ALLOWANCES[planId];
  if (!notifications || !limit) return;
  try {
    const rows = await repo.rows(accountId, now);
    if (rows.error || !rows.data) return;
    await notifications.afterIncludedUsage(
      accountId,
      {
        planName: PLANS[planId]?.name ?? planId,
        usedMicrodollars: usageTotals(rows.data, now).thirtyDay,
        limitMicrodollars: limit.thirtyDay,
        minimumMicrodollars: MINIMUM_REQUEST_MICRODOLLARS,
      },
      now,
    );
  } catch (err) {
    logger.error(`Included allowance notice failed: ${(err as Error).message}`);
  }
}
