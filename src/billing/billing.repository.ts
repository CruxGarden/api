import type { CheckoutRequest } from './provider';
import { accountTransaction } from '../common/helpers/account-transaction';
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
  /** the checkout session last opened; sync recovers from it if no webhook came */
  pending_session_id?: string | null;
  updated: Date | string;
}

export interface CheckoutAttempt {
  account_id: string;
  id: string;
  provider: string;
  request: CheckoutRequest;
  status: 'preparing' | 'open' | 'completed' | 'expired';
  session_id: string | null;
  session_url: string | null;
  created_at: Date | string;
  updated_at: Date | string;
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

  /** One account's provider observation, projection and receipt commit together.
   * Provider calls in this operation must be bounded; notification delivery runs afterward.
   */
  async forAccount<T>(
    accountId: string,
    work: (closed: boolean) => Promise<T>,
    scope: 'live' | 'retained' = 'live',
  ): Promise<T> {
    return accountTransaction(this.dbService, accountId, work, scope);
  }

  async isClosing(accountId: string): Promise<RepositoryResponse<boolean>> {
    try {
      const state = await this.dbService
        .query()('billing_account_state')
        .where({ account_id: accountId })
        .first();
      return success(!!state?.closing_at);
    } catch (error) {
      return failure(error);
    }
  }

  async markClosing(accountId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()('billing_account_state')
        .insert({ account_id: accountId, closing_at: new Date() })
        .onConflict('account_id')
        .merge({ closing_at: new Date() });
      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  }

  async checkoutAttempt(
    accountId: string,
  ): Promise<RepositoryResponse<CheckoutAttempt | null>> {
    try {
      const row = await this.dbService
        .query()('billing_checkout_attempts')
        .where({ account_id: accountId })
        .first();
      if (row && typeof row.request === 'string')
        row.request = JSON.parse(row.request);
      return success(row ?? null);
    } catch (error) {
      return failure(error);
    }
  }

  async saveCheckoutAttempt(
    attempt: CheckoutAttempt,
  ): Promise<RepositoryResponse<void>> {
    try {
      const row = {
        ...attempt,
        request: JSON.stringify(attempt.request),
        updated_at: new Date(),
      };
      await this.dbService
        .query()('billing_checkout_attempts')
        .insert(row)
        .onConflict('account_id')
        .merge(row);
      return success(undefined);
    } catch (error) {
      return failure(error);
    }
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

  /** Remember (or clear) the checkout session an account just opened. */
  async setPendingSession(
    accountId: string,
    sessionId: string | null,
    provider = 'stripe',
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('subscriptions')
        .insert({
          account_id: accountId,
          pending_session_id: sessionId,
          provider,
          plan_id: 'free',
          status: 'none',
          updated: new Date(),
        })
        .onConflict('account_id')
        .merge({ pending_session_id: sessionId, updated: new Date() });
      return success(undefined);
    } catch (error) {
      this.logger.error('setPendingSession failed', error as Error);
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

  /** A completed receipt remains a duplicate even after its account is closed. */
  async eventCompleted(
    id: string,
    provider: string,
  ): Promise<RepositoryResponse<boolean>> {
    try {
      const row = await this.dbService
        .query()('billing_events')
        .where({ id, provider })
        .whereNotNull('payload')
        .first('id');
      return success(!!row);
    } catch (error) {
      this.logger.error('eventCompleted failed', error as Error);
      return failure(error);
    }
  }

  /**
   * Called inside forAccount: claim, projection and payload completion share
   * one transaction. A process exit rolls them back. An old null-payload claim
   * from the former nontransactional handler is recoverable on redelivery.
   */
  async claimEvent(
    id: string,
    provider: string,
    type: string,
  ): Promise<RepositoryResponse<boolean>> {
    try {
      const rows = await this.dbService.query().raw(
        `INSERT INTO billing_events (id, provider, type) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type
         WHERE billing_events.payload IS NULL RETURNING id`,
        [id, provider, type],
      );
      const list = (rows.rows ?? rows) as unknown[];
      return success(list.length > 0);
    } catch (error) {
      this.logger.error('claimEvent failed', error as Error);
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
