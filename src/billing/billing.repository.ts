import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';

export interface SubscriptionRow {
  account_id: string;
  provider: string;
  customer_id: string | null;
  subscription_id: string | null;
  plan_id: string;
  price_id: string | null;
  interval: string | null;
  status: string;
  current_period_start: Date | string | null;
  current_period_end: Date | string | null;
  cancel_at_period_end: boolean;
  trial_end: Date | string | null;
  /** when the account first went past_due (the grace clock); null when not past due */
  past_due_since?: Date | string | null;
  updated: Date | string;
}

@Injectable()
export class BillingRepository {
  private readonly logger: LoggerService;
  constructor(
    private readonly dbService: DbService,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('BillingRepository');
  }

  async byAccount(
    accountId: string,
  ): Promise<RepositoryResponse<SubscriptionRow | null>> {
    try {
      const row = await this.dbService
        .query()
        .from<SubscriptionRow>('subscriptions')
        .where({ account_id: accountId })
        .first();
      return success(row ?? null);
    } catch (error) {
      this.logger.error('byAccount failed', error as Error);
      return failure(error);
    }
  }

  async byCustomer(
    customerId: string,
  ): Promise<RepositoryResponse<SubscriptionRow | null>> {
    try {
      const row = await this.dbService
        .query()
        .from<SubscriptionRow>('subscriptions')
        .where({ customer_id: customerId })
        .first();
      return success(row ?? null);
    } catch (error) {
      this.logger.error('byCustomer failed', error as Error);
      return failure(error);
    }
  }

  async bySubscription(
    subscriptionId: string,
  ): Promise<RepositoryResponse<SubscriptionRow | null>> {
    try {
      const row = await this.dbService
        .query()
        .from<SubscriptionRow>('subscriptions')
        .where({ subscription_id: subscriptionId })
        .first();
      return success(row ?? null);
    } catch (error) {
      this.logger.error('bySubscription failed', error as Error);
      return failure(error);
    }
  }

  async upsert(
    row: Omit<SubscriptionRow, 'updated'>,
  ): Promise<RepositoryResponse<SubscriptionRow>> {
    try {
      const [saved] = await this.dbService
        .query()
        .from('subscriptions')
        .insert({ ...row, updated: new Date() })
        .onConflict('account_id')
        .merge({ ...row, updated: new Date() })
        .returning('*');
      return success(saved as SubscriptionRow);
    } catch (error) {
      this.logger.error('upsert failed', error as Error);
      return failure(error);
    }
  }

  async setCustomer(
    accountId: string,
    customerId: string,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('subscriptions')
        .insert({
          account_id: accountId,
          customer_id: customerId,
          plan_id: 'free',
          status: 'none',
          updated: new Date(),
        })
        .onConflict('account_id')
        .merge({ customer_id: customerId, updated: new Date() });
      return success(undefined);
    } catch (error) {
      this.logger.error('setCustomer failed', error as Error);
      return failure(error);
    }
  }

  async accountEmail(
    accountId: string,
  ): Promise<RepositoryResponse<string | null>> {
    try {
      const row = await this.dbService
        .query()
        .from('accounts')
        .where({ id: accountId })
        .first<{ email: string }>('email');
      return success(row?.email ?? null);
    } catch (error) {
      this.logger.error('accountEmail failed', error as Error);
      return failure(error);
    }
  }

  /**
   * Claim a webhook event before acting on it: the INSERT is the idempotency
   * lock, so two deliveries (Stripe retries, two API instances) cannot both
   * run. Returns true when this caller owns the event.
   */
  async claimEvent(
    id: string,
    provider: string,
    type: string,
  ): Promise<RepositoryResponse<boolean>> {
    try {
      const rows = await this.dbService.query().raw(
        `INSERT INTO billing_events (id, provider, type) VALUES (?, ?, ?)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, provider, type],
      );
      const list = (rows.rows ?? rows) as unknown[];
      return success(list.length > 0);
    } catch (error) {
      this.logger.error('claimEvent failed', error as Error);
      return failure(error);
    }
  }

  /** Give a claim back when processing threw, so the provider's retry gets another go. */
  async releaseEvent(id: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('billing_events')
        .where({ id })
        .delete();
      return success(undefined);
    } catch (error) {
      this.logger.error('releaseEvent failed', error as Error);
      return failure(error);
    }
  }

  /** true when this event id was already processed (idempotency) */
  async eventSeen(id: string): Promise<RepositoryResponse<boolean>> {
    try {
      const row = await this.dbService
        .query()
        .from('billing_events')
        .where({ id })
        .first('id');
      return success(!!row);
    } catch (error) {
      this.logger.error('eventSeen failed', error as Error);
      return failure(error);
    }
  }

  async recordEvent(
    id: string,
    provider: string,
    type: string,
    accountId: string | null,
    payload: unknown,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('billing_events')
        .insert({
          id,
          provider,
          type,
          account_id: accountId,
          payload: JSON.stringify(payload ?? null),
        })
        .onConflict('id')
        .merge({
          account_id: accountId,
          payload: JSON.stringify(payload ?? null),
        });
      return success(undefined);
    } catch (error) {
      this.logger.error('recordEvent failed', error as Error);
      return failure(error);
    }
  }

  async list(limit = 100): Promise<RepositoryResponse<SubscriptionRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<SubscriptionRow>('subscriptions')
        .orderBy('updated', 'desc')
        .limit(limit)
        .select('*');
      return success(rows);
    } catch (error) {
      this.logger.error('list failed', error as Error);
      return failure(error);
    }
  }
}
