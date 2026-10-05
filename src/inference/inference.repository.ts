import { Injectable } from '@nestjs/common';
import { success, failure } from '../common/helpers/repository-helpers';
import type { RepositoryResponse } from '../common/types/interfaces';
import { DbService } from '../common/services/db.service';
import {
  HOUR,
  admitOutput,
  reservation,
  type Allowance,
  type Tokens,
} from './policy';
export type InferenceKind = 'chat' | 'image';
/**
 * `interrupted`: stopped mid-stream, charged the measured tokens.
 * `estimated`: a provider success without usage, charged the documented estimate.
 * `uncertain`: started, nothing measured, the reservation is retained.
 * `abandoned`: the request died with the server and was released (ADR 0082).
 */
export type SettlementStatus =
  | 'complete'
  | 'interrupted'
  | 'estimated'
  | 'uncertain'
  | 'rejected'
  | 'abandoned';
export interface UsageRow {
  id: string;
  account_id?: string;
  model: string;
  status: string;
  kind?: InferenceKind | null;
  crux_id?: string | null;
  reserved_microdollars?: string | number;
  charged_microdollars: string | number;
  created: Date;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  adjusted?: Date | null;
  adjusted_from_microdollars?: string | number | null;
}
/**
 * One way to serve a request. `amount` is the full-length reservation; when
 * `input` and `output` are given, a request that does not fit at full length
 * is admitted with the largest output budget that does (ADR 0082).
 */
export interface ReservationChoice {
  model: string;
  amount: number;
  input?: number;
  output?: number;
}
export interface Reserved {
  model: string;
  amount: number;
  /** The output budget the reservation covers, when it was clamped or computed. */
  maxTokens?: number;
}
export interface Attribution {
  cruxId?: string | null;
  kind?: InferenceKind;
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
  async find(id: string): Promise<RepositoryResponse<UsageRow | null>> {
    try {
      return success(
        ((await this.db
          .query()('inference_requests')
          .where({ id })
          .whereNull('deleted')
          .first()) as UsageRow | undefined) ?? null,
      );
    } catch (e) {
      return failure<UsageRow | null>(e);
    }
  }
  async reserve(
    accountId: string,
    id: string,
    choices: ReservationChoice[],
    limit: Allowance,
    now = new Date(),
    attribution: Attribution = {},
  ): Promise<RepositoryResponse<Reserved>> {
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
          const choice = admit(choices, remainingOf(rows, limit, now));
          if (!choice) throw new ReservationError('allowance');
          await tx('inference_requests').insert({
            id,
            account_id: accountId,
            model: choice.model,
            status: 'reserved',
            reserved_microdollars: choice.amount,
            charged_microdollars: choice.amount,
            kind: attribution.kind ?? 'chat',
            crux_id: attribution.cruxId ?? null,
            created: now,
          });
          return choice;
        }),
      );
    } catch (e) {
      return failure<Reserved>(e);
    }
  }
  /**
   * Record what the provider has measured so far on a live reservation, so a
   * request that dies with the server can still be settled at measured usage.
   */
  async progress(accountId: string, id: string, tokens: Tokens) {
    try {
      await this.db
        .query()('inference_requests')
        .where({ id, account_id: accountId, status: 'reserved' })
        .whereNull('deleted')
        .update({
          input_tokens: tokens.input,
          output_tokens: tokens.output,
          cache_read_tokens: tokens.cacheRead,
          cache_write_tokens: tokens.cacheWrite,
        });
      return success(true);
    } catch (e) {
      return failure<boolean>(e);
    }
  }
  async settle(
    accountId: string,
    id: string,
    amount: number,
    tokens: Tokens | null,
    status: SettlementStatus,
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
  /** Live reservations created before `before`, oldest first. */
  async stale(
    before: Date,
    limit = 500,
  ): Promise<RepositoryResponse<UsageRow[]>> {
    try {
      return success(
        await this.db
          .query()('inference_requests')
          .where({ status: 'reserved' })
          .whereNull('deleted')
          .where('created', '<', before)
          .orderBy('created', 'asc')
          .limit(limit),
      );
    } catch (e) {
      return failure<UsageRow[]>(e);
    }
  }
  /**
   * Operator correction, lower-only and settled-only, as one compare-and-set:
   * the first adjustment's prior charge is kept as `adjusted_from_microdollars`.
   */
  async adjust(
    id: string,
    chargedMicrodollars: number,
    reason: string,
    adminAccountId: string,
    now = new Date(),
  ): Promise<RepositoryResponse<UsageRow | null>> {
    try {
      const rows = (await this.db
        .query()('inference_requests')
        .where({ id })
        .whereNull('deleted')
        .whereNot({ status: 'reserved' })
        .where('charged_microdollars', '>', chargedMicrodollars)
        .update({
          adjusted_from_microdollars: this.db
            .query()
            .raw('COALESCE(adjusted_from_microdollars, charged_microdollars)'),
          charged_microdollars: chargedMicrodollars,
          adjusted: now,
          adjusted_by: adminAccountId,
          adjustment_reason: reason,
        })
        .returning('*')) as UsageRow[];
      return success(rows[0] ?? null);
    } catch (e) {
      return failure<UsageRow | null>(e);
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
/** Microdollars left in the tighter of the two rolling windows. */
export function remainingOf(
  rows: UsageRow[],
  limit: Allowance,
  now = new Date(),
): number {
  const totals = usageTotals(rows, now);
  return Math.min(
    limit.thirtyDay - totals.thirtyDay,
    limit.fiveHour - totals.fiveHour,
  );
}
/** The first choice that fits at full length, or clamped to what remains. */
export function admit(
  choices: ReservationChoice[],
  remaining: number,
): Reserved | null {
  for (const c of choices) {
    if (c.amount <= remaining)
      return {
        model: c.model,
        amount: c.amount,
        ...(c.output !== undefined ? { maxTokens: c.output } : {}),
      };
    if (c.input === undefined || c.output === undefined) continue;
    const output = admitOutput(c.model, c.input, c.output, remaining);
    if (output !== null)
      return {
        model: c.model,
        amount: reservation(c.model, c.input, output),
        maxTokens: output,
      };
  }
  return null;
}
