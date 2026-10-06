import { Injectable } from '@nestjs/common';
import { LoggerService } from '../common/services/logger.service';
import { EmailService } from '../common/services/email.service';
import { UsageService, type AccountUsage } from './usage.service';
import { UsageRepository } from './usage.repository';
import { BillingService } from '../billing/billing.service';
import { SETTLEMENT } from './plans';

/**
 * Usage notices (grace-first, ADR 0011/0012): a plain email when an account
 * crosses 80 % of a budget and another when it passes the soft limit — once
 * per kind per billing period, never more. Nothing here blocks anything; the
 * point is that a limit is never a surprise.
 */
export type NoticeKind =
  | 'storage_80'
  | 'storage_soft'
  | 'bandwidth_80'
  | 'bandwidth_soft'
  | 'store_80';

const GB = 1024 ** 3;

/**
 * Included collaboration allowance notices (ADR 0082): the rolling 30-day
 * window passing 80 %, and reaching the point where not even a minimal next
 * request fits. Each kind at most once in any 30 days.
 */
export type IncludedNoticeKind = 'included_80' | 'included_full';
export interface IncludedAllowance {
  planName: string;
  usedMicrodollars: number;
  limitMicrodollars: number;
  /** The smallest request the allowance admits; below this it is effectively full. */
  minimumMicrodollars: number;
}
const DAY = 86_400_000;
const INCLUDED_NOTICE_DAYS = 30;
/** The notice's ledger period: fixed 30-day buckets, so concurrent claims collide. */
export function includedNoticePeriod(now: Date): string {
  const bucket = Math.floor(now.getTime() / (INCLUDED_NOTICE_DAYS * DAY));
  return new Date(bucket * INCLUDED_NOTICE_DAYS * DAY)
    .toISOString()
    .slice(0, 10);
}

@Injectable()
export class NotificationsService {
  private readonly logger: LoggerService;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly usage: UsageService,
    private readonly billing: BillingService,
    private readonly email: EmailService,
    private readonly repo: UsageRepository,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('NotificationsService');
  }

  /** Which notices this usage snapshot warrants (pure). */
  static due(u: AccountUsage): NoticeKind[] {
    const out: NoticeKind[] = [];
    const frac = (used: number, limit: number) =>
      limit > 0 ? used / limit : 0;
    const s = frac(u.storageBytes, u.plan.storageBytes);
    const b = frac(u.bandwidthBytes, u.plan.bandwidthBytesPerPeriod);
    const r = frac(u.store.requests, u.plan.storeRequestsPerPeriod);
    if (s >= SETTLEMENT.softLimitFactor) out.push('storage_soft');
    else if (s >= 0.8) out.push('storage_80');
    if (b >= SETTLEMENT.softLimitFactor) out.push('bandwidth_soft');
    else if (b >= 0.8) out.push('bandwidth_80');
    if (r >= 0.8) out.push('store_80');
    return out;
  }

  /** After a publish or sync push: check this account, send what is due and unsent. */
  async afterWrite(
    authorId: string,
    accountId: string | null | undefined,
  ): Promise<NoticeKind[]> {
    if (!accountId) return [];
    try {
      const planId = await this.billing.planIdFor(accountId);
      const u = await this.usage.forAuthor(
        authorId,
        { plan: planId },
        new Date(),
        accountId,
      );
      return await this.sendDue(accountId, u);
    } catch (err) {
      this.logger.error(`afterWrite failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async sendDue(
    accountId: string,
    u: AccountUsage,
  ): Promise<NoticeKind[]> {
    const sent: NoticeKind[] = [];
    for (const kind of NotificationsService.due(u)) {
      const email = (await this.repo.accountEmailFor(accountId)).data;
      if (!email) break;
      // The ledger row is the lock: claim it first so two publishes in flight
      // (or two API instances) cannot both send the same notice.
      const claimed = await this.repo.markNotified(
        accountId,
        kind,
        u.period.start,
      );
      if (!claimed.data) continue;
      const msg = notice(kind, u);
      try {
        await this.email.send({ email, subject: msg.subject, body: msg.body });
      } catch (err) {
        await this.repo.unmarkNotified(accountId, kind, u.period.start);
        throw err;
      }
      sent.push(kind);
      this.logger.info('Usage notice sent', { accountId, kind });
    }
    return sent;
  }

  /** Which included-allowance notice this window warrants (pure); full supersedes 80 %. */
  static includedDue(a: IncludedAllowance): IncludedNoticeKind | null {
    if (a.limitMicrodollars <= 0) return null;
    if (a.usedMicrodollars + a.minimumMicrodollars > a.limitMicrodollars)
      return 'included_full';
    if (a.usedMicrodollars >= 0.8 * a.limitMicrodollars) return 'included_80';
    return null;
  }

  /**
   * After an included request settles. The ledger row is still the lock (the
   * period is a fixed 30-day bucket so concurrent settles collide), and a
   * notice sent in the previous 30 days — including a full notice, which
   * supersedes 80 % — keeps the bucket boundary from sending it twice.
   */
  async afterIncludedUsage(
    accountId: string,
    allowance: IncludedAllowance,
    now = new Date(),
  ): Promise<IncludedNoticeKind | null> {
    try {
      const kind = NotificationsService.includedDue(allowance);
      if (!kind) return null;
      const covering: IncludedNoticeKind[] =
        kind === 'included_80'
          ? ['included_80', 'included_full']
          : ['included_full'];
      const recent = await this.repo.notificationSentSince(
        accountId,
        covering,
        new Date(now.getTime() - INCLUDED_NOTICE_DAYS * DAY),
      );
      if (recent.error || recent.data !== false) return null;
      const email = (await this.repo.accountEmailFor(accountId)).data;
      if (!email) return null;
      const period = includedNoticePeriod(now);
      const claimed = await this.repo.markNotified(accountId, kind, period);
      if (!claimed.data) return null;
      const msg = includedNotice(kind, allowance);
      try {
        await this.email.send({ email, subject: msg.subject, body: msg.body });
      } catch (err) {
        await this.repo.unmarkNotified(accountId, kind, period);
        throw err;
      }
      this.logger.info('Included allowance notice sent', { accountId, kind });
      return kind;
    } catch (err) {
      this.logger.error(`afterIncludedUsage failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Bandwidth arrives from logs, not from a user action — sweep every few hours. */
  async sweep(now = new Date()): Promise<number> {
    const period = { start: now.toISOString().slice(0, 8) + '01', end: '' };
    const authors =
      (await this.repo.authorsActiveInPeriod(period.start, '9999-12-31'))
        .data ?? [];
    let n = 0;
    for (const authorId of authors) {
      const acct = (await this.repo.authorAccount(authorId)).data;
      if (!acct?.account_id) continue;
      n += (await this.afterWrite(authorId, acct.account_id)).length;
    }
    return n;
  }

  startScheduler(intervalMs = 6 * 60 * 60 * 1000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(
      () => void this.sweep().catch(() => {}),
      intervalMs,
    );
  }
  stopScheduler(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

function gb(bytes: number): string {
  return bytes >= GB
    ? `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function notice(
  kind: NoticeKind,
  u: AccountUsage,
): { subject: string; body: string } {
  const plan = u.plan.name;
  const foot =
    `\n\nNothing is cut off. Sites keep serving and backups keep working; new publishes only stop at twice the plan.` +
    `\nA bigger plan is one click in Crux Garden → Settings → Plan.\n\n— Crux Garden`;
  switch (kind) {
    case 'storage_80':
      return {
        subject: `You're using most of your ${plan} storage`,
        body: `You've published and backed up ${gb(u.storageBytes)} of the ${gb(u.plan.storageBytes)} on the ${plan} plan.${foot}`,
      };
    case 'storage_soft':
      return {
        subject: `You're over your ${plan} storage`,
        body: `You're at ${gb(u.storageBytes)} of ${gb(u.plan.storageBytes)} on the ${plan} plan. Everything you've published stays up.${foot}`,
      };
    case 'bandwidth_80':
      return {
        subject: `Your sites are busy — 80 % of this month's bandwidth`,
        body: `Visitors have pulled ${gb(u.bandwidthBytes)} of the ${gb(u.plan.bandwidthBytesPerPeriod)} included this month on the ${plan} plan. Bandwidth is never throttled; the counter resets on the 1st.${foot}`,
      };
    case 'bandwidth_soft':
      return {
        subject: `Over this month's bandwidth on ${plan} — sites still serving`,
        body: `Your sites have served ${gb(u.bandwidthBytes)} against ${gb(u.plan.bandwidthBytesPerPeriod)} this month. We don't throttle. If this is the new normal, a bigger plan fits better.${foot}`,
      };
    case 'store_80':
      return {
        subject: `Crux Store: 80 % of this month's requests`,
        body: `Your published cruxes have made ${u.store.requests.toLocaleString()} of the ${u.plan.storeRequestsPerPeriod.toLocaleString()} store requests included this month on the ${plan} plan. Requests are not cut off.${foot}`,
      };
  }
}

function dollars(microdollars: number): string {
  return `$${(Math.max(0, microdollars) / 1_000_000).toFixed(2)}`;
}

export function includedNotice(
  kind: IncludedNoticeKind,
  a: IncludedAllowance,
): { subject: string; body: string } {
  const used = `${dollars(a.usedMicrodollars)} of ${dollars(a.limitMicrodollars)}`;
  const foot =
    `\n\nThe allowance is a rolling 30 days: each request frees up again 30 days after it was made, so there is no reset date to wait for.` +
    `\nYour own API key keeps working at any time, and Crux Garden → Settings → Usage shows the next release.\n\n— Crux Garden`;
  switch (kind) {
    case 'included_80':
      return {
        subject: `You've used 80 % of your included collaboration`,
        body: `In the last 30 days your included collaboration on the ${a.planName} plan has used ${used}.${foot}`,
      };
    case 'included_full':
      return {
        subject: `Your included collaboration is used up for now`,
        body: `In the last 30 days your included collaboration on the ${a.planName} plan has used ${used}, so there is not enough left to start another request. Nothing you made is affected.${foot}`,
      };
  }
}
