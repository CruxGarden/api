import { LoggerService } from '../common/services/logger.service';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DbService } from '../common/services/db.service';
import { failure, success } from '../common/helpers/repository-helpers';
import type { RepositoryResponse } from '../common/types/interfaces';

export interface NoticeCondition {
  subscriptionId: string;
  status?: string;
  planId?: string;
  trialEndsAt?: string;
}

export interface BillingNotice {
  id: string;
  account_id: string;
  subject: string;
  body: string;
  attempts: number;
  lease_id: string | null;
  condition: NoticeCondition | string | null;
}

/** Small durable queues. Leases coordinate replicas; all writes use DbService's
 * current transaction so subscription changes and notice intents commit together.
 */
@Injectable()
export class BillingOperationsRepository {
  private readonly logger: LoggerService;
  constructor(
    private readonly database: DbService,
    logger: LoggerService,
  ) {
    this.logger = logger.createChildLogger('BillingOperationsRepository');
  }
  private async result<T>(
    work: () => Promise<T>,
  ): Promise<RepositoryResponse<T>> {
    try {
      return success(await work());
    } catch (error) {
      this.logger.error('Billing operational query failed');
      return failure(error);
    }
  }

  enqueue(
    accountId: string,
    message: { subject: string; body: string },
    dedupeKey?: string,
    condition?: NoticeCondition,
  ) {
    return this.result(async () => {
      await this.database
        .query()('billing_notifications')
        .insert({
          id: randomUUID(),
          account_id: accountId,
          ...message,
          dedupe_key: dedupeKey ?? null,
          condition: condition ? JSON.stringify(condition) : null,
        })
        .onConflict('dedupe_key')
        .ignore();
    });
  }

  recordAbsentCheckout(
    attemptId: string,
    accountId: string,
    operatorId: string,
    provider: string,
    reviewReference: string,
  ) {
    return this.result(async () => {
      await this.database.query()('billing_checkout_resolutions').insert({
        attempt_id: attemptId,
        account_id: accountId,
        operator_id: operatorId,
        provider,
        review_reference: reviewReference,
      });
    });
  }

  /** Discover bounded batches of accounts without scanning/loading every subscription. */
  discover() {
    return this.result(async () => {
      const db = this.database.query();
      const ids = await db('accounts as a')
        .select('a.id')
        .whereNull('a.deleted')
        .whereNotExists(
          db('billing_reconciliation as r')
            .select('r.account_id')
            .whereRaw('r.account_id = a.id'),
        )
        .where(function () {
          this.whereExists(
            db('subscriptions as s')
              .select('s.account_id')
              .whereRaw('s.account_id = a.id'),
          ).orWhereExists(
            db('billing_checkout_attempts as c')
              .select('c.account_id')
              .whereRaw('c.account_id = a.id'),
          );
        })
        .limit(100);
      if (ids.length)
        await db('billing_reconciliation')
          .insert(ids.map(({ id }) => ({ account_id: id })))
          .onConflict('account_id')
          .ignore();
    });
  }

  candidates(now: Date, limit = 5) {
    return this.result(async (): Promise<string[]> => {
      const db = this.database.query();
      const rows = await db('billing_reconciliation as r')
        .join('accounts as a', 'a.id', 'r.account_id')
        .whereNull('a.deleted')
        .where('r.due_at', '<=', now)
        .where(function () {
          this.whereNull('r.lease_until').orWhere('r.lease_until', '<=', now);
        })
        .orderBy('r.due_at')
        .limit(limit)
        .select('r.account_id');
      return rows.map((r) => r.account_id);
    });
  }

  claim(accountId: string, now: Date, force = false) {
    return this.result(async (): Promise<string | null> => {
      const db = this.database.query();
      await db('billing_reconciliation')
        .insert({ account_id: accountId })
        .onConflict('account_id')
        .ignore();
      const lease = randomUUID();
      let q = db('billing_reconciliation')
        .where({ account_id: accountId })
        .where(function () {
          this.whereNull('lease_until').orWhere('lease_until', '<=', now);
        });
      if (!force) q = q.where('due_at', '<=', now);
      const changed = await q.update({
        lease_id: lease,
        lease_until: new Date(now.getTime() + 15 * 60_000),
      });
      return changed ? lease : null;
    });
  }

  finish(
    accountId: string,
    lease: string,
    now: Date,
    failureCode: string | null,
  ) {
    return this.result(async () => {
      const db = this.database.query();
      const row = await db('billing_reconciliation')
        .where({ account_id: accountId, lease_id: lease })
        .first();
      if (!row) return false;
      const failures = failureCode ? row.failures + 1 : 0;
      return !!(await db('billing_reconciliation')
        .where({ account_id: accountId, lease_id: lease })
        .update({
          verified_at: failureCode ? row.verified_at : now,
          failed_at: failureCode ? now : null,
          failure_code: failureCode,
          failures,
          due_at: new Date(
            now.getTime() +
              (failureCode ? Math.min(60, 2 ** Math.min(failures, 6)) : 15) *
                60_000,
          ),
          lease_id: null,
          lease_until: null,
        }));
    });
  }

  delivery(
    eventId: string,
    provider: string,
    type: string,
    code: string | null,
  ) {
    return this.result(async () => {
      const db = this.database.query();
      if (!code) {
        await db('billing_delivery_failures')
          .where({ event_id: eventId, provider })
          .update({ recovered_at: new Date() });
        return;
      }
      await db('billing_delivery_failures')
        .insert({
          event_id: eventId,
          provider,
          event_type: type,
          failure_code: code,
          failed_at: new Date(),
        })
        .onConflict('event_id')
        .merge({
          failure_code: code,
          failed_at: new Date(),
          recovered_at: null,
          attempts: db.raw('billing_delivery_failures.attempts + 1'),
        });
    });
  }

  dueNotices(now: Date, limit = 10) {
    return this.result(
      async (): Promise<BillingNotice[]> =>
        this.database
          .query()('billing_notifications')
          .whereNull('sent_at')
          .where('due_at', '<=', now)
          .where(function () {
            this.whereNull('lease_until').orWhere('lease_until', '<=', now);
          })
          .orderBy('due_at')
          .limit(limit),
    );
  }
  claimNotice(id: string, now: Date) {
    return this.result(async (): Promise<string | null> => {
      const lease = randomUUID();
      const changed = await this.database
        .query()('billing_notifications')
        .where({ id })
        .whereNull('sent_at')
        .where(function () {
          this.whereNull('lease_until').orWhere('lease_until', '<=', now);
        })
        .update({
          lease_id: lease,
          lease_until: new Date(now.getTime() + 15 * 60_000),
        });
      return changed ? lease : null;
    });
  }
  finishNotice(
    notice: BillingNotice,
    lease: string,
    now: Date,
    code: string | null,
    outcome = 'sent',
  ) {
    return this.result(async () => {
      const attempts = notice.attempts + 1;
      return !!(await this.database
        .query()('billing_notifications')
        .where({ id: notice.id, lease_id: lease })
        .update({
          sent_at: code ? null : now,
          outcome: code ? null : outcome,
          attempts,
          failure_code: code,
          due_at: new Date(
            now.getTime() + Math.min(360, 2 ** Math.min(attempts, 9)) * 60_000,
          ),
          lease_id: null,
          lease_until: null,
        }));
    });
  }
  recipient(accountId: string) {
    return this.result(
      async (): Promise<string | null> =>
        (
          await this.database
            .query()('accounts')
            .where({ id: accountId })
            .whereNull('deleted')
            .first('email')
        )?.email ?? null,
    );
  }
  trialNotice(accountId: string, now: Date) {
    return this.result(
      async (): Promise<{
        end: Date;
        key: string;
        subscriptionId: string;
      } | null> => {
        const row = await this.database
          .query()('subscriptions')
          .where({ account_id: accountId, status: 'trialing' })
          .first();
        if (!row?.trial_end || !row?.subscription_id) return null;
        const end = new Date(row.trial_end);
        if (end <= now || end.getTime() - now.getTime() > 3 * 86400000)
          return null;
        return {
          end,
          key: `trial:${row.subscription_id}:${end.toISOString()}`,
          subscriptionId: row.subscription_id,
        };
      },
    );
  }

  noticeSubscription(accountId: string) {
    return this.result(
      async () =>
        (await this.database
          .query()('subscriptions')
          .where({ account_id: accountId })
          .first()) ?? null,
    );
  }

  health(now: Date) {
    return this.result(async () => {
      const db = this.database.query();
      const count = async (q) =>
        Number((await q.count({ count: '*' }).first()).count);
      const active = () =>
        db('billing_reconciliation as r')
          .join('accounts as a', 'a.id', 'r.account_id')
          .whereNull('a.deleted');
      const [
        failed,
        stale,
        unchecked,
        due,
        pending,
        ambiguous,
        closing,
        deliveryFailures,
        pendingNotices,
        failedNotices,
        latest,
      ] = await Promise.all([
        count(active().whereNotNull('r.failure_code')),
        count(
          active().where(
            'r.verified_at',
            '<',
            new Date(now.getTime() - 60 * 60_000),
          ),
        ),
        count(
          db('accounts as a')
            .leftJoin('billing_reconciliation as r', 'r.account_id', 'a.id')
            .whereNull('a.deleted')
            .whereNull('r.verified_at')
            .where(function () {
              this.whereExists(
                db('subscriptions as s')
                  .select('s.account_id')
                  .whereRaw('s.account_id = a.id'),
              ).orWhereExists(
                db('billing_checkout_attempts as c')
                  .select('c.account_id')
                  .whereRaw('c.account_id = a.id'),
              );
            }),
        ),
        count(active().where('r.due_at', '<=', now)),
        count(
          db('billing_checkout_attempts as c')
            .join('accounts as a', 'a.id', 'c.account_id')
            .whereNull('a.deleted')
            .whereIn('c.status', ['preparing', 'open']),
        ),
        count(
          db('billing_checkout_attempts as c')
            .join('accounts as a', 'a.id', 'c.account_id')
            .whereNull('a.deleted')
            .where({ 'c.status': 'preparing' })
            .whereNull('session_id')
            .where(
              'created_at',
              '<=',
              new Date(now.getTime() - 23 * 60 * 60_000),
            ),
        ),
        count(
          db('billing_account_state as s')
            .join('accounts as a', 'a.id', 's.account_id')
            .whereNull('a.deleted')
            .whereNotNull('s.closing_at'),
        ),
        count(
          db('billing_delivery_failures as f')
            .whereNull('f.recovered_at')
            .whereNotExists(
              db('billing_events as e')
                .select('e.id')
                .whereRaw('e.id = f.event_id')
                .whereNotNull('e.payload'),
            ),
        ),
        count(db('billing_notifications').whereNull('sent_at')),
        count(
          db('billing_notifications')
            .whereNull('sent_at')
            .whereNotNull('failure_code'),
        ),
        db('billing_events')
          .whereNotNull('payload')
          .max({ completedAt: 'received_at' })
          .first(),
      ]);
      return {
        failed,
        stale,
        unchecked,
        due,
        pendingCheckouts: pending,
        ambiguousCheckouts: ambiguous,
        closingAccounts: closing,
        webhookFailures: deliveryFailures,
        pendingNotifications: pendingNotices,
        failedNotifications: failedNotices,
        latestCompletedWebhook: latest?.completedAt ?? null,
      };
    });
  }
  problems() {
    return this.result(async () => {
      const db = this.database.query();
      // Admin only; exclude payloads, URLs, email and exact payment requests.
      const [accounts, deliveries, checkouts] = await Promise.all([
        db('billing_reconciliation as r')
          .join('accounts as a', 'a.id', 'r.account_id')
          .whereNull('a.deleted')
          .whereNotNull('r.failure_code')
          .select(
            'r.account_id',
            'verified_at',
            'failed_at',
            'failure_code',
            'failures',
            'due_at',
          )
          .orderBy('failed_at', 'desc')
          .limit(50),
        db('billing_delivery_failures as f')
          .whereNull('f.recovered_at')
          .whereNotExists(
            db('billing_events as e')
              .select('e.id')
              .whereRaw('e.id = f.event_id')
              .whereNotNull('e.payload'),
          )
          .select(
            'event_id',
            'event_type',
            'failure_code',
            'attempts',
            'failed_at',
          )
          .orderBy('failed_at', 'desc')
          .limit(50),
        db('billing_checkout_attempts as c')
          .join('accounts as a', 'a.id', 'c.account_id')
          .whereNull('a.deleted')
          .whereIn('c.status', ['preparing', 'open'])
          .select(
            'c.account_id',
            'c.id',
            'c.status',
            'c.session_id',
            'c.created_at',
          )
          .orderBy('created_at')
          .limit(50),
      ]);
      return { accounts, deliveries, checkouts };
    });
  }
}
