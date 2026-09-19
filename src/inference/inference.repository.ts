import { Injectable } from '@nestjs/common';
import { success, failure } from '../common/helpers/repository-helpers';
import type { RepositoryResponse } from '../common/types/interfaces';
import { DbService } from '../common/services/db.service';
import { HOUR, type Allowance, type Tokens } from './policy';
export interface UsageRow {
  id: string;
  model: string;
  status: string;
  charged_microdollars: string | number;
  created: Date;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}
export class ReservationError extends Error {
  constructor(readonly reason: 'duplicate' | 'concurrent' | 'allowance') {
    super(reason);
  }
}
@Injectable()
export class InferenceRepository {
  constructor(private readonly db: DbService) {}
  async rows(
    accountId: string,
    now = new Date(),
  ): Promise<RepositoryResponse<UsageRow[]>> {
    try {
      return success(
        await this.db
          .query()('inference_requests')
          .where({ account_id: accountId })
          .whereNull('deleted')
          .where('created', '>', new Date(now.getTime() - 720 * HOUR))
          .orderBy('created', 'asc'),
      );
    } catch (e) {
      return failure<UsageRow[]>(e);
    }
  }
  async reserve(
    accountId: string,
    id: string,
    choices: { model: string; amount: number }[],
    limit: Allowance,
    now = new Date(),
  ) {
    try {
      return success(
        await this.db.query().transaction(async (tx) => {
          // Serialize all reservations for an account, across processes and devices.
          await tx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
            accountId,
          ]);
          if (await tx('inference_requests').where({ id }).first())
            throw new ReservationError('duplicate');
          const rows: UsageRow[] = await tx('inference_requests')
            .where({ account_id: accountId })
            .whereNull('deleted')
            .where('created', '>', new Date(now.getTime() - 720 * HOUR));
          if (
            rows.filter(
              (r) =>
                r.status === 'reserved' &&
                new Date(r.created).getTime() > now.getTime() - 10 * 60_000,
            ).length >= 2
          )
            throw new ReservationError('concurrent');
          const totals = usageTotals(rows, now);
          const choice = choices.find(
            (c) =>
              totals.thirtyDay + c.amount <= limit.thirtyDay &&
              totals.fiveHour + c.amount <= limit.fiveHour,
          );
          if (!choice) throw new ReservationError('allowance');
          await tx('inference_requests').insert({
            id,
            account_id: accountId,
            model: choice.model,
            status: 'reserved',
            reserved_microdollars: choice.amount,
            charged_microdollars: choice.amount,
            created: now,
          });
          return choice;
        }),
      );
    } catch (e) {
      return failure<{ model: string; amount: number }>(e);
    }
  }
  async settle(
    accountId: string,
    id: string,
    amount: number,
    tokens: Tokens | null,
    status: 'complete' | 'uncertain' | 'rejected',
  ) {
    // Compare-and-set: duplicate finish/abort/error callbacks cannot bill twice.
    try {
      await this.db
        .query()('inference_requests')
        .where({ id, account_id: accountId, status: 'reserved' })
        .whereNull('deleted')
        .update({
          charged_microdollars: amount,
          status,
          settled: new Date(),
          input_tokens: tokens?.input ?? null,
          output_tokens: tokens?.output ?? null,
          cache_read_tokens: tokens?.cacheRead ?? null,
          cache_write_tokens: tokens?.cacheWrite ?? null,
        });
      return success(true);
    } catch (e) {
      return failure<boolean>(e);
    }
  }
}
export function usageTotals(rows: UsageRow[], now = new Date()) {
  const recent = rows.filter(
    (r) => new Date(r.created).getTime() > now.getTime() - 5 * HOUR,
  );
  const sum = (list: UsageRow[]) =>
    list.reduce((n, r) => n + Number(r.charged_microdollars), 0);
  return {
    thirtyDay: sum(rows),
    fiveHour: sum(recent),
  };
}
