import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';

export interface UsageStorageRow {
  crux_id: string;
  author_id: string;
  bytes: string | number;
  files: number;
  updated: Date;
}
export interface UsageSyncObjectRow {
  account_id: string;
  kind: 'garden' | 'crux';
  object_id: string;
  bytes: string | number;
  title: string | null;
  updated: Date;
}
export interface UsageSyncDailyRow {
  account_id: string;
  day: string;
  bytes_up: string | number;
  bytes_down: string | number;
  uploads: string | number;
  downloads: string | number;
}
export interface UsageReconciliationRow {
  day: string;
  metered_bytes: string | number;
  edge_bytes: string | number | null;
  gap_pct: string | number | null;
  status: 'ok' | 'gap' | 'nodata';
  checked_at: Date;
}
export interface UsagePeriodRow {
  id?: string;
  author_id: string;
  account_id: string | null;
  period_start: string;
  period_end: string;
  plan_id: string;
  storage_limit: number;
  bandwidth_limit: number;
  storage_bytes: number;
  publish_storage_bytes: number;
  sync_storage_bytes: number;
  bandwidth_bytes: number;
  publish_bandwidth_bytes: number;
  sync_transfer_bytes: number;
  requests: number;
  over_storage: boolean;
  over_bandwidth: boolean;
  reconciliation_status: string | null;
  finalized_at?: Date | string;
}
export interface UsageDailyRow {
  author_id: string;
  crux_id: string;
  day: string;
  bytes: string | number;
  requests: string | number;
}

@Injectable()
export class UsageRepository {
  private readonly logger: LoggerService;
  constructor(
    private readonly dbService: DbService,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('UsageRepository');
  }

  async upsertStorage(
    cruxId: string,
    authorId: string,
    bytes: number,
    files: number,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('usage_storage')
        .insert({
          crux_id: cruxId,
          author_id: authorId,
          bytes,
          files,
          updated: new Date(),
        })
        .onConflict('crux_id')
        .merge({ author_id: authorId, bytes, files, updated: new Date() });
      return success(undefined);
    } catch (error) {
      this.logger.error('upsertStorage failed', error as Error);
      return failure(error);
    }
  }

  async deleteStorage(cruxId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('usage_storage')
        .where('crux_id', cruxId)
        .delete();
      return success(undefined);
    } catch (error) {
      this.logger.error('deleteStorage failed', error as Error);
      return failure(error);
    }
  }

  async storageByAuthor(
    authorId: string,
  ): Promise<RepositoryResponse<UsageStorageRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<UsageStorageRow>('usage_storage')
        .where('author_id', authorId)
        .orderBy('bytes', 'desc');
      return success(rows);
    } catch (error) {
      this.logger.error('storageByAuthor failed', error as Error);
      return failure(error);
    }
  }

  /** Add (not replace) bytes/requests for a crux-day. Log files never overlap, so adding is safe. */
  async addDaily(
    authorId: string,
    cruxId: string,
    day: string,
    bytes: number,
    requests: number,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService.query().raw(
        `INSERT INTO usage_daily (author_id, crux_id, day, bytes, requests)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (crux_id, day) DO UPDATE SET
           bytes = usage_daily.bytes + EXCLUDED.bytes,
           requests = usage_daily.requests + EXCLUDED.requests,
           author_id = EXCLUDED.author_id,
           updated = now()`,
        [authorId, cruxId, day, bytes, requests],
      );
      return success(undefined);
    } catch (error) {
      this.logger.error('addDaily failed', error as Error);
      return failure(error);
    }
  }

  async dailyByAuthor(
    authorId: string,
    start: string,
    end: string,
  ): Promise<RepositoryResponse<UsageDailyRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<UsageDailyRow>('usage_daily')
        .where('author_id', authorId)
        .where('day', '>=', start)
        .where('day', '<', end);
      return success(rows);
    } catch (error) {
      this.logger.error('dailyByAuthor failed', error as Error);
      return failure(error);
    }
  }

  async dailyByCrux(
    cruxId: string,
    start: string,
    end: string,
  ): Promise<RepositoryResponse<UsageDailyRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<UsageDailyRow>('usage_daily')
        .where('crux_id', cruxId)
        .where('day', '>=', start)
        .where('day', '<', end);
      return success(rows);
    } catch (error) {
      this.logger.error('dailyByCrux failed', error as Error);
      return failure(error);
    }
  }

  async storageByCrux(
    cruxId: string,
  ): Promise<RepositoryResponse<UsageStorageRow | undefined>> {
    try {
      const row = await this.dbService
        .query()
        .from<UsageStorageRow>('usage_storage')
        .where('crux_id', cruxId)
        .first();
      return success(row);
    } catch (error) {
      this.logger.error('storageByCrux failed', error as Error);
      return failure(error);
    }
  }

  async ingestSeen(key: string): Promise<RepositoryResponse<boolean>> {
    try {
      const row = await this.dbService
        .query()
        .from('usage_ingest')
        .where('key', key)
        .first();
      return success(!!row);
    } catch (error) {
      this.logger.error('ingestSeen failed', error as Error);
      return failure(error);
    }
  }

  async markIngested(
    key: string,
    bytes: number,
    requests: number,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('usage_ingest')
        .insert({ key, bytes, requests })
        .onConflict('key')
        .ignore();
      return success(undefined);
    } catch (error) {
      this.logger.error('markIngested failed', error as Error);
      return failure(error);
    }
  }

  /** crux → author for hosts that aren't UUID subdomains (custom domains). */
  async cruxForHostname(
    hostname: string,
  ): Promise<
    RepositoryResponse<{ crux_id: string; author_id: string } | undefined>
  > {
    try {
      const row = await this.dbService
        .query()
        .from('custom_domains')
        .select('crux_id', 'author_id')
        .where('hostname', hostname.toLowerCase())
        .whereNull('deleted')
        .first();
      return success(row as { crux_id: string; author_id: string } | undefined);
    } catch (error) {
      this.logger.error('cruxForHostname failed', error as Error);
      return failure(error);
    }
  }

  async authorForCrux(
    cruxId: string,
  ): Promise<RepositoryResponse<string | undefined>> {
    try {
      const row = await this.dbService
        .query()
        .from('cruxes')
        .select('author_id')
        .where('id', cruxId)
        .first();
      return success((row as { author_id: string } | undefined)?.author_id);
    } catch (error) {
      this.logger.error('authorForCrux failed', error as Error);
      return failure(error);
    }
  }

  /** Titles for a set of cruxes (for the account usage table). */
  async titlesFor(
    cruxIds: string[],
  ): Promise<RepositoryResponse<Record<string, string>>> {
    if (cruxIds.length === 0) return success({});
    try {
      const rows = await this.dbService
        .query()
        .from('cruxes')
        .whereIn('id', cruxIds)
        .select('id', 'title');
      const out: Record<string, string> = {};
      for (const r of rows as { id: string; title: string | null }[])
        if (r.title) out[r.id] = r.title;
      return success(out);
    } catch (error) {
      this.logger.error('titlesFor failed', error as Error);
      return failure(error);
    }
  }

  /** When the newest log file was ingested (survives API restarts). */
  async lastIngestAt(): Promise<RepositoryResponse<string | null>> {
    try {
      const row = await this.dbService
        .query()
        .from('usage_ingest')
        .max('processed_at as at')
        .first<{ at: Date | string | null }>();
      return success(row?.at ? new Date(row.at).toISOString() : null);
    } catch (error) {
      this.logger.error('lastIngestAt failed', error as Error);
      return failure(error);
    }
  }

  // ── Sync (tied to the account) ──────────────────────────────────────────
  async upsertSyncObject(
    accountId: string,
    kind: 'garden' | 'crux',
    objectId: string,
    bytes: number,
    title: string | null,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('usage_sync_objects')
        .insert({
          account_id: accountId,
          kind,
          object_id: objectId,
          bytes,
          title,
          updated: new Date(),
        })
        .onConflict(['account_id', 'kind', 'object_id'])
        .merge({ bytes, title, updated: new Date() });
      return success(undefined);
    } catch (error) {
      this.logger.error('upsertSyncObject failed', error as Error);
      return failure(error);
    }
  }

  async deleteSyncObject(
    accountId: string,
    kind: 'garden' | 'crux',
    objectId: string,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('usage_sync_objects')
        .where({ account_id: accountId, kind, object_id: objectId })
        .delete();
      return success(undefined);
    } catch (error) {
      this.logger.error('deleteSyncObject failed', error as Error);
      return failure(error);
    }
  }

  async syncObjectsByAccount(
    accountId: string,
  ): Promise<RepositoryResponse<UsageSyncObjectRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<UsageSyncObjectRow>('usage_sync_objects')
        .where({ account_id: accountId })
        .select('*');
      return success(rows);
    } catch (error) {
      this.logger.error('syncObjectsByAccount failed', error as Error);
      return failure(error);
    }
  }

  async addSyncDaily(
    accountId: string,
    day: string,
    bytesUp: number,
    bytesDown: number,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService.query().raw(
        `INSERT INTO usage_sync_daily (account_id, day, bytes_up, bytes_down, uploads, downloads)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, day) DO UPDATE SET
           bytes_up = usage_sync_daily.bytes_up + EXCLUDED.bytes_up,
           bytes_down = usage_sync_daily.bytes_down + EXCLUDED.bytes_down,
           uploads = usage_sync_daily.uploads + EXCLUDED.uploads,
           downloads = usage_sync_daily.downloads + EXCLUDED.downloads,
           updated = now()`,
        [
          accountId,
          day,
          bytesUp,
          bytesDown,
          bytesUp > 0 ? 1 : 0,
          bytesDown > 0 ? 1 : 0,
        ],
      );
      return success(undefined);
    } catch (error) {
      this.logger.error('addSyncDaily failed', error as Error);
      return failure(error);
    }
  }

  async syncDailyByAccount(
    accountId: string,
    start: string,
    end: string,
  ): Promise<RepositoryResponse<UsageSyncDailyRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<UsageSyncDailyRow>('usage_sync_daily')
        .where({ account_id: accountId })
        .andWhere('day', '>=', start)
        .andWhere('day', '<', end)
        .select('*');
      return success(rows);
    } catch (error) {
      this.logger.error('syncDailyByAccount failed', error as Error);
      return failure(error);
    }
  }

  // ── Reconciliation (our count vs CloudFront's) ──────────────────────────
  async meteredBytesForDay(day: string): Promise<RepositoryResponse<number>> {
    try {
      const row = await this.dbService
        .query()
        .from('usage_daily')
        .where({ day })
        .sum('bytes as total')
        .first<{ total: string | number | null }>();
      return success(Number(row?.total ?? 0) || 0);
    } catch (error) {
      this.logger.error('meteredBytesForDay failed', error as Error);
      return failure(error);
    }
  }

  async upsertReconciliation(
    row: Omit<UsageReconciliationRow, 'checked_at'>,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('usage_reconciliation')
        .insert({ ...row, checked_at: new Date() })
        .onConflict('day')
        .merge({ ...row, checked_at: new Date() });
      return success(undefined);
    } catch (error) {
      this.logger.error('upsertReconciliation failed', error as Error);
      return failure(error);
    }
  }

  async listReconciliation(
    limit = 31,
  ): Promise<RepositoryResponse<UsageReconciliationRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<UsageReconciliationRow>('usage_reconciliation')
        .orderBy('day', 'desc')
        .limit(limit)
        .select('*');
      return success(rows);
    } catch (error) {
      this.logger.error('listReconciliation failed', error as Error);
      return failure(error);
    }
  }

  // ── Finalized periods ───────────────────────────────────────────────────
  /** Authors with any publish or sync activity inside a period. */
  async authorsActiveInPeriod(
    start: string,
    end: string,
  ): Promise<RepositoryResponse<string[]>> {
    try {
      const rows = await this.dbService.query().raw(
        `SELECT DISTINCT author_id FROM (
           SELECT author_id FROM usage_storage
           UNION
           SELECT author_id FROM usage_daily WHERE day >= ? AND day < ?
           UNION
           SELECT a.id AS author_id FROM authors a
             JOIN usage_sync_objects o ON o.account_id = a.account_id
           UNION
           SELECT a.id AS author_id FROM authors a
             JOIN usage_sync_daily d ON d.account_id = a.account_id
             WHERE d.day >= ? AND d.day < ?
         ) x`,
        [start, end, start, end],
      );
      const list = (rows.rows ?? rows) as { author_id: string }[];
      return success(list.map((r) => r.author_id));
    } catch (error) {
      this.logger.error('authorsActiveInPeriod failed', error as Error);
      return failure(error);
    }
  }

  async authorAccount(authorId: string): Promise<
    RepositoryResponse<{
      account_id: string | null;
      meta: Record<string, unknown> | null;
    } | null>
  > {
    try {
      const row = await this.dbService
        .query()
        .from('authors')
        .where({ id: authorId })
        .whereNull('deleted')
        .first<{
          account_id: string | null;
          meta: unknown;
        }>('account_id', 'meta');
      if (!row) return success(null);
      const meta =
        typeof row.meta === 'string'
          ? (JSON.parse(row.meta) as Record<string, unknown>)
          : ((row.meta as Record<string, unknown> | null) ?? null);
      return success({ account_id: row.account_id, meta });
    } catch (error) {
      this.logger.error('authorAccount failed', error as Error);
      return failure(error);
    }
  }

  async periodFinalized(
    authorId: string,
    periodStart: string,
  ): Promise<RepositoryResponse<boolean>> {
    try {
      const row = await this.dbService
        .query()
        .from('usage_periods')
        .where({ author_id: authorId, period_start: periodStart })
        .first('id');
      return success(!!row);
    } catch (error) {
      this.logger.error('periodFinalized failed', error as Error);
      return failure(error);
    }
  }

  async insertPeriod(row: UsagePeriodRow): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('usage_periods')
        .insert({ ...row, finalized_at: new Date() })
        .onConflict(['author_id', 'period_start'])
        .ignore();
      return success(undefined);
    } catch (error) {
      this.logger.error('insertPeriod failed', error as Error);
      return failure(error);
    }
  }

  async periodsForAuthor(
    authorId: string,
    limit = 12,
  ): Promise<RepositoryResponse<UsagePeriodRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<UsagePeriodRow>('usage_periods')
        .where({ author_id: authorId })
        .orderBy('period_start', 'desc')
        .limit(limit)
        .select('*');
      return success(rows);
    } catch (error) {
      this.logger.error('periodsForAuthor failed', error as Error);
      return failure(error);
    }
  }
}
