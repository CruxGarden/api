import { accountTransaction } from '../common/helpers/account-transaction';
import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { success, failure } from '../common/helpers/repository-helpers';
import { RepositoryResponse } from '../common/types/interfaces';
import type { SubscriptionSnapshot, CheckoutSessionInfo } from './provider';

interface SimulationRecord {
  id: string;
  account_id: string;
  kind: string;
  provider_id: string;
  data: any;
}
const dataOf = (row: SimulationRecord) =>
  typeof row.data === 'string' ? JSON.parse(row.data) : row.data;

@Injectable()
export class BillingSimulationRepository {
  private readonly logger: LoggerService;
  constructor(
    private readonly db: DbService,
    logger: LoggerService,
  ) {
    this.logger = logger.createChildLogger('BillingSimulationRepository');
  }

  /** Account lock spans provider state and the entitlement projection together. */
  async forAccount<T>(
    accountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return accountTransaction(this.db, accountId, operation);
  }

  async change(
    accountId: string,
    transform: (current: SubscriptionSnapshot) => SubscriptionSnapshot,
  ): Promise<RepositoryResponse<SubscriptionSnapshot>> {
    try {
      return success(
        await this.forAccount(accountId, async () => {
          const db = this.db.query();
          const customer = await db<SimulationRecord>('billing_simulation')
            .where({ id: `customer:${accountId}` })
            .first();
          const subscriptionId = customer && dataOf(customer).subscriptionId;
          const row =
            subscriptionId &&
            (await db<SimulationRecord>('billing_simulation')
              .where({
                kind: 'subscription',
                provider_id: subscriptionId,
                account_id: accountId,
              })
              .first());
          if (!row)
            throw new NotFoundException('No simulated subscription yet');
          const next = transform(dataOf(row));
          await db('billing_simulation')
            .where({ id: row.id })
            .update({ data: JSON.stringify(next) });
          return next;
        }),
      );
    } catch (error) {
      return failure(error);
    }
  }

  async read<T>(
    kind: string,
    providerId: string,
  ): Promise<RepositoryResponse<T | null>> {
    try {
      const row = await this.db
        .query()<SimulationRecord>('billing_simulation')
        .where({ kind, provider_id: providerId })
        .first();
      return success(row ? (dataOf(row) as T) : null);
    } catch (error) {
      this.logger.error('read failed', error as Error);
      return failure(error);
    }
  }

  /** Customer-row serialization keeps simultaneous checkouts from racing. */
  async checkout(
    accountId: string,
    make: (
      customerId: string,
      current: SubscriptionSnapshot | null,
    ) => SubscriptionSnapshot,
  ): Promise<RepositoryResponse<{ sessionId: string }>> {
    try {
      return success(
        await this.db.transaction(async () => {
          const db = this.db.query();
          const key = `customer:${accountId}`;
          await db('billing_simulation')
            .insert({
              id: key,
              account_id: accountId,
              kind: 'customer',
              provider_id: `cus_sim_${randomUUID()}`,
              data: JSON.stringify({ subscriptionId: null }),
            })
            .onConflict('id')
            .ignore();
          let query = db<SimulationRecord>('billing_simulation').where({
            id: key,
          });
          if (db.client.dialect !== 'sqlite3') query = query.forUpdate();
          const customer = await query.first();
          const currentId = dataOf(customer).subscriptionId;
          const current = currentId
            ? await db<SimulationRecord>('billing_simulation')
                .where({ kind: 'subscription', provider_id: currentId })
                .first()
            : null;
          const snapshot = make(
            customer.provider_id,
            current ? dataOf(current) : null,
          );
          const sessionId = `cs_sim_${randomUUID()}`;
          const session: CheckoutSessionInfo = {
            customerId: snapshot.customerId,
            subscriptionId: snapshot.subscriptionId,
            status: 'complete',
            accountId,
            attemptId: null,
            url: null,
          };
          await db('billing_simulation').insert([
            {
              id: snapshot.subscriptionId,
              kind: 'subscription',
              provider_id: snapshot.subscriptionId,
              account_id: accountId,
              data: JSON.stringify(snapshot),
            },
            {
              id: sessionId,
              kind: 'session',
              provider_id: sessionId,
              account_id: accountId,
              data: JSON.stringify(session),
            },
          ]);
          await db('billing_simulation')
            .where({ id: key })
            .update({
              data: JSON.stringify({ subscriptionId: snapshot.subscriptionId }),
            });
          return { sessionId };
        }),
      );
    } catch (error) {
      this.logger.error('checkout failed', error as Error);
      return failure(error);
    }
  }
}
