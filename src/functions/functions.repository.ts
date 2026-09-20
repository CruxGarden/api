import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';

export interface CruxSecretRow {
  crux_id: string;
  name: string;
  ciphertext: string;
  iv: string;
  tag: string;
  updated: Date | string;
}

export interface FunctionScheduleRow {
  crux_id: string;
  name: string;
  schedule: string;
  next_run: Date | string;
  last_run: Date | string | null;
  last_status: string | null;
}

/** The `function_schedules` table: which published handlers run on the clock, and when next. */
@Injectable()
export class FunctionsRepository {
  private readonly logger: LoggerService;
  constructor(
    private readonly dbService: DbService,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('FunctionsRepository');
  }

  /** Make the table hold exactly `rows` for this crux (others removed; existing keep their next_run when the schedule is unchanged). */
  async syncSchedules(
    cruxId: string,
    rows: { name: string; schedule: string; nextRun: Date }[],
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService.query().transaction(async (tx) => {
        const names = rows.map((r) => r.name);
        const del = tx('function_schedules').where({ crux_id: cruxId });
        if (names.length) del.whereNotIn('name', names);
        await del.delete();
        for (const r of rows) {
          await tx.raw(
            `INSERT INTO function_schedules (crux_id, name, schedule, next_run)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (crux_id, name) DO UPDATE SET
               schedule = EXCLUDED.schedule,
               next_run = CASE WHEN function_schedules.schedule = EXCLUDED.schedule
                          THEN function_schedules.next_run ELSE EXCLUDED.next_run END,
               updated = now()`,
            [cruxId, r.name, r.schedule, r.nextRun],
          );
        }
      });
      return success(undefined);
    } catch (error) {
      this.logger.error('syncSchedules failed', error as Error);
      return failure(error);
    }
  }

  async deleteSchedules(cruxId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()('function_schedules')
        .where({ crux_id: cruxId })
        .delete();
      return success(undefined);
    } catch (error) {
      this.logger.error('deleteSchedules failed', error as Error);
      return failure(error);
    }
  }

  async listSchedules(
    cruxId: string,
  ): Promise<RepositoryResponse<FunctionScheduleRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<FunctionScheduleRow>('function_schedules')
        .where({ crux_id: cruxId })
        .select('*');
      return success(rows);
    } catch (error) {
      this.logger.error('listSchedules failed', error as Error);
      return failure(error);
    }
  }

  /**
   * Claim the rows due at `now`: each is advanced to `next(row)` inside the
   * same transaction (FOR UPDATE SKIP LOCKED), so two API instances never run
   * the same firing. Returns the rows as they were, for running.
   */
  async claimDue(
    now: Date,
    next: (row: FunctionScheduleRow) => Date | null,
    limit = 20,
  ): Promise<RepositoryResponse<FunctionScheduleRow[]>> {
    try {
      const claimed: FunctionScheduleRow[] = [];
      await this.dbService.query().transaction(async (tx) => {
        const rows = (await tx
          .from<FunctionScheduleRow>('function_schedules')
          .where('next_run', '<=', now)
          .orderBy('next_run')
          .limit(limit)
          .forUpdate()
          .skipLocked()
          .select('*')) as FunctionScheduleRow[];
        for (const row of rows) {
          const n = next(row);
          if (n)
            await tx('function_schedules')
              .where({ crux_id: row.crux_id, name: row.name })
              .update({ next_run: n, last_run: now, updated: now });
          else
            await tx('function_schedules')
              .where({ crux_id: row.crux_id, name: row.name })
              .delete();
          claimed.push(row);
        }
      });
      return success(claimed);
    } catch (error) {
      this.logger.error('claimDue failed', error as Error);
      return failure(error);
    }
  }

  async setStatus(
    cruxId: string,
    name: string,
    status: string,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()('function_schedules')
        .where({ crux_id: cruxId, name })
        .update({ last_status: status.slice(0, 200) });
      return success(undefined);
    } catch (error) {
      this.logger.error('setStatus failed', error as Error);
      return failure(error);
    }
  }

  // ── Secrets (F1) ──────────────────────────────────────────────────────
  async putSecret(
    cruxId: string,
    name: string,
    enc: { ciphertext: string; iv: string; tag: string },
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService.query().raw(
        `INSERT INTO crux_secrets (crux_id, name, ciphertext, iv, tag)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (crux_id, name) DO UPDATE SET
           ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, updated = now()`,
        [cruxId, name, enc.ciphertext, enc.iv, enc.tag],
      );
      return success(undefined);
    } catch (error) {
      this.logger.error('putSecret failed', error as Error);
      return failure(error);
    }
  }

  async deleteSecret(
    cruxId: string,
    name: string,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()('crux_secrets')
        .where({ crux_id: cruxId, name })
        .delete();
      return success(undefined);
    } catch (error) {
      this.logger.error('deleteSecret failed', error as Error);
      return failure(error);
    }
  }

  async secretsFor(
    cruxId: string,
  ): Promise<RepositoryResponse<CruxSecretRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<CruxSecretRow>('crux_secrets')
        .where({ crux_id: cruxId })
        .select('*');
      return success(rows);
    } catch (error) {
      this.logger.error('secretsFor failed', error as Error);
      return failure(error);
    }
  }
}
