import { Injectable, NotFoundException } from '@nestjs/common';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { LoggerService } from '../common/services/logger.service';
import {
  UsageRepository,
  type UsageSyncDailyRow,
  type UsagePeriodRow,
  type UsageReconciliationRow,
} from './usage.repository';
import { parseCloudFrontLog, cruxIdFromPublishHost } from './cloudfront-logs';
import {
  SETTLEMENT,
  billingPeriod,
  planFor,
  previousBillingPeriod,
  settlementFor,
  type Plan,
} from './plans';
import { type EdgeMetrics, edgeMetricsFromEnv } from './edge-metrics';

export interface CruxUsage {
  cruxId: string;
  title?: string;
  storageBytes: number;
  files: number;
  bandwidthBytes: number;
  requests: number;
}

/** One synced object (the garden backup, or one crux archive). */
export interface SyncObjectUsage {
  kind: 'garden' | 'crux';
  id: string;
  title: string | null;
  bytes: number;
  updated: string;
}

export interface SyncUsage {
  /** bytes held in the sync store right now */
  storageBytes: number;
  gardenBytes: number;
  gardenSyncedAt: string | null;
  cruxBytes: number;
  cruxCount: number;
  /** transfer this billing period */
  transferBytes: number;
  uploadBytes: number;
  downloadBytes: number;
  uploads: number;
  downloads: number;
  objects: SyncObjectUsage[];
}

/** One budget line: what the plan allows, what's used, and where grace ends. */
export interface BudgetLine {
  limit: number;
  used: number;
  /** enforcement (future) triggers here, not at `limit` */
  softLimit: number;
  over: boolean;
  overSoft: boolean;
}

export interface ReconciliationView {
  day: string;
  status: 'ok' | 'gap' | 'nodata';
  meteredBytes: number;
  edgeBytes: number | null;
  gapPct: number | null;
  checkedAt: string;
}

export interface PeriodView {
  period: { start: string; end: string };
  planId: string;
  storageBytes: number;
  publishStorageBytes: number;
  syncStorageBytes: number;
  bandwidthBytes: number;
  publishBandwidthBytes: number;
  syncTransferBytes: number;
  requests: number;
  storageLimit: number;
  bandwidthLimit: number;
  overStorage: boolean;
  overBandwidth: boolean;
  reconciliationStatus: string | null;
  finalizedAt: string;
}

export interface AccountUsage {
  period: { start: string; end: string };
  plan: Plan;
  /** when this period's numbers stop moving (period end + grace) */
  settlement: { finalizesAt: string; isFinal: boolean; graceHours: number };
  budgets: { storage: BudgetLine; bandwidth: BudgetLine };
  /** latest daily check of our bandwidth count against CloudFront's */
  reconciliation: ReconciliationView | null;
  /** totals against the plan: publish + sync */
  storageBytes: number;
  bandwidthBytes: number;
  requests: number;
  /** published sites */
  publish: { storageBytes: number; bandwidthBytes: number; requests: number };
  cruxes: CruxUsage[];
  /** garden backups and synced cruxes, tied to the account */
  sync: SyncUsage;
  /** when bandwidth was last ingested (null = never) */
  bandwidthAsOf: string | null;
}

/** Reads log files; abstracted so ingestion is testable without S3. */
export interface LogSource {
  list(): Promise<string[]>;
  read(key: string): Promise<Buffer>;
}

const n = (v: string | number | null | undefined) => Number(v ?? 0) || 0;

const budget = (limit: number, used: number): BudgetLine => {
  const softLimit = Math.round(limit * SETTLEMENT.softLimitFactor);
  return {
    limit,
    used,
    softLimit,
    over: limit > 0 && used > limit,
    overSoft: limit > 0 && used > softLimit,
  };
};

const reconView = (r: UsageReconciliationRow): ReconciliationView => ({
  day: String(r.day).slice(0, 10),
  status: r.status,
  meteredBytes: n(r.metered_bytes),
  edgeBytes: r.edge_bytes === null ? null : n(r.edge_bytes),
  gapPct: r.gap_pct === null ? null : Number(r.gap_pct),
  checkedAt: new Date(r.checked_at).toISOString(),
});

const periodView = (p: UsagePeriodRow): PeriodView => ({
  period: {
    start: String(p.period_start).slice(0, 10),
    end: String(p.period_end).slice(0, 10),
  },
  planId: p.plan_id,
  storageBytes: n(p.storage_bytes),
  publishStorageBytes: n(p.publish_storage_bytes),
  syncStorageBytes: n(p.sync_storage_bytes),
  bandwidthBytes: n(p.bandwidth_bytes),
  publishBandwidthBytes: n(p.publish_bandwidth_bytes),
  syncTransferBytes: n(p.sync_transfer_bytes),
  requests: n(p.requests),
  storageLimit: n(p.storage_limit),
  bandwidthLimit: n(p.bandwidth_limit),
  overStorage: p.over_storage,
  overBandwidth: p.over_bandwidth,
  reconciliationStatus: p.reconciliation_status,
  finalizedAt: new Date(p.finalized_at ?? Date.now()).toISOString(),
});

const emptySync = (): SyncUsage => ({
  storageBytes: 0,
  gardenBytes: 0,
  gardenSyncedAt: null,
  cruxBytes: 0,
  cruxCount: 0,
  transferBytes: 0,
  uploadBytes: 0,
  downloadBytes: 0,
  uploads: 0,
  downloads: 0,
  objects: [],
});

@Injectable()
export class UsageService {
  private readonly logger: LoggerService;
  private ingestTimer: ReturnType<typeof setInterval> | null = null;
  private lastIngest: string | null = null;

  constructor(
    private readonly repo: UsageRepository,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('UsageService');
  }

  // ── Storage (exact, at publish time) ────────────────────────────────────
  async recordStorage(
    cruxId: string,
    authorId: string,
    bytes: number,
    files: number,
  ): Promise<void> {
    const r = await this.repo.upsertStorage(cruxId, authorId, bytes, files);
    if (r.error)
      this.logger.error(
        `recordStorage failed for ${cruxId}: ${String(r.error)}`,
      );
  }

  async clearStorage(cruxId: string): Promise<void> {
    const r = await this.repo.deleteStorage(cruxId);
    if (r.error)
      this.logger.error(
        `clearStorage failed for ${cruxId}: ${String(r.error)}`,
      );
  }

  // ── Sync (garden backups + synced cruxes, per account) ──────────────────
  async recordSyncObject(
    accountId: string,
    kind: 'garden' | 'crux',
    objectId: string,
    bytes: number,
    title: string | null = null,
  ): Promise<void> {
    const r = await this.repo.upsertSyncObject(
      accountId,
      kind,
      objectId,
      bytes,
      title,
    );
    if (r.error)
      this.logger.error(
        `recordSyncObject failed for ${accountId}/${kind}/${objectId}: ${String(r.error)}`,
      );
  }

  async clearSyncObject(
    accountId: string,
    kind: 'garden' | 'crux',
    objectId: string,
  ): Promise<void> {
    const r = await this.repo.deleteSyncObject(accountId, kind, objectId);
    if (r.error)
      this.logger.error(
        `clearSyncObject failed for ${accountId}/${kind}/${objectId}: ${String(r.error)}`,
      );
  }

  /** Bytes moved through the sync endpoints, counted on the UTC day they happen. */
  async recordTransfer(
    accountId: string,
    bytesUp: number,
    bytesDown: number,
    now = new Date(),
  ): Promise<void> {
    if (bytesUp <= 0 && bytesDown <= 0) return;
    const day = now.toISOString().slice(0, 10);
    const r = await this.repo.addSyncDaily(accountId, day, bytesUp, bytesDown);
    if (r.error)
      this.logger.error(
        `recordTransfer failed for ${accountId}: ${String(r.error)}`,
      );
  }

  async syncForAccount(
    accountId: string,
    period: { start: string; end: string },
  ): Promise<SyncUsage> {
    const [objects, daily] = await Promise.all([
      this.repo.syncObjectsByAccount(accountId),
      this.repo.syncDailyByAccount(accountId, period.start, period.end),
    ]);
    const list: SyncObjectUsage[] = (objects.data ?? []).map((o) => ({
      kind: o.kind,
      id: o.object_id,
      title: o.title,
      bytes: n(o.bytes),
      updated: new Date(o.updated).toISOString(),
    }));
    const garden = list.find((o) => o.kind === 'garden') ?? null;
    const cruxes = list.filter((o) => o.kind === 'crux');
    const sum = (k: keyof UsageSyncDailyRow) =>
      (daily.data ?? []).reduce((s, r) => s + n(r[k] as string | number), 0);
    const uploadBytes = sum('bytes_up');
    const downloadBytes = sum('bytes_down');
    return {
      storageBytes: list.reduce((s, o) => s + o.bytes, 0),
      gardenBytes: garden?.bytes ?? 0,
      gardenSyncedAt: garden?.updated ?? null,
      cruxBytes: cruxes.reduce((s, o) => s + o.bytes, 0),
      cruxCount: cruxes.length,
      transferBytes: uploadBytes + downloadBytes,
      uploadBytes,
      downloadBytes,
      uploads: sum('uploads'),
      downloads: sum('downloads'),
      objects: list.sort((a, b) => b.bytes - a.bytes),
    };
  }

  // ── Reads ───────────────────────────────────────────────────────────────
  async forAuthor(
    authorId: string,
    authorMeta: Record<string, unknown> | null | undefined,
    now = new Date(),
    accountId?: string,
  ): Promise<AccountUsage> {
    const period = billingPeriod(now);
    const [storage, daily, sync, lastIngest, recon] = await Promise.all([
      this.repo.storageByAuthor(authorId),
      this.repo.dailyByAuthor(authorId, period.start, period.end),
      accountId
        ? this.syncForAccount(accountId, period)
        : Promise.resolve(emptySync()),
      this.repo.lastIngestAt(),
      this.repo.listReconciliation(1),
    ]);
    const byCrux = new Map<string, CruxUsage>();
    for (const row of storage.data ?? []) {
      byCrux.set(row.crux_id, {
        cruxId: row.crux_id,
        storageBytes: n(row.bytes),
        files: row.files,
        bandwidthBytes: 0,
        requests: 0,
      });
    }
    for (const row of daily.data ?? []) {
      const c = byCrux.get(row.crux_id) ?? {
        cruxId: row.crux_id,
        storageBytes: 0,
        files: 0,
        bandwidthBytes: 0,
        requests: 0,
      };
      c.bandwidthBytes += n(row.bytes);
      c.requests += n(row.requests);
      byCrux.set(row.crux_id, c);
    }
    const titles = await this.repo.titlesFor([...byCrux.keys()]);
    for (const c of byCrux.values())
      c.title = titles.data?.[c.cruxId] || undefined;
    const cruxes = [...byCrux.values()].sort(
      (a, b) =>
        b.storageBytes + b.bandwidthBytes - (a.storageBytes + a.bandwidthBytes),
    );
    const publish = {
      storageBytes: cruxes.reduce((s, c) => s + c.storageBytes, 0),
      bandwidthBytes: cruxes.reduce((s, c) => s + c.bandwidthBytes, 0),
      requests: cruxes.reduce((s, c) => s + c.requests, 0),
    };
    const plan = planFor(authorMeta);
    const storageBytes = publish.storageBytes + sync.storageBytes;
    const bandwidthBytes = publish.bandwidthBytes + sync.transferBytes;
    const latest = recon.data?.[0];
    return {
      period,
      plan,
      settlement: settlementFor(period, now),
      budgets: {
        storage: budget(plan.storageBytes, storageBytes),
        bandwidth: budget(plan.bandwidthBytesPerPeriod, bandwidthBytes),
      },
      reconciliation: latest ? reconView(latest) : null,
      storageBytes,
      bandwidthBytes,
      requests: publish.requests,
      publish,
      cruxes,
      sync,
      bandwidthAsOf: lastIngest.data ?? this.lastIngest,
    };
  }

  async forCrux(cruxId: string, now = new Date()): Promise<CruxUsage> {
    const period = billingPeriod(now);
    const [storage, daily] = await Promise.all([
      this.repo.storageByCrux(cruxId),
      this.repo.dailyByCrux(cruxId, period.start, period.end),
    ]);
    if (storage.error) throw new NotFoundException('Usage not found');
    return {
      cruxId,
      storageBytes: n(storage.data?.bytes),
      files: storage.data?.files ?? 0,
      bandwidthBytes: (daily.data ?? []).reduce((s, r) => s + n(r.bytes), 0),
      requests: (daily.data ?? []).reduce((s, r) => s + n(r.requests), 0),
    };
  }

  // ── Reconciliation: our metered bytes vs CloudFront's BytesDownloaded ───
  /**
   * Check the last `days` complete UTC days. A day is `gap` when our count trails
   * CloudFront's by more than SETTLEMENT.reconcileGapPct (lost or late log files),
   * `nodata` when CloudWatch has nothing, `ok` otherwise.
   */
  async reconcile(
    metrics: EdgeMetrics,
    days = 3,
    now = new Date(),
  ): Promise<ReconciliationView[]> {
    const out: ReconciliationView[] = [];
    for (let i = 1; i <= days; i++) {
      const day = new Date(now.getTime() - i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const metered = (await this.repo.meteredBytesForDay(day)).data ?? 0;
      let edge: number | null = null;
      try {
        edge = await metrics.bytesDownloaded(day);
      } catch (err) {
        this.logger.error(
          `CloudWatch read failed for ${day}: ${(err as Error).message}`,
        );
      }
      let status: ReconciliationView['status'] = 'nodata';
      let gapPct: number | null = null;
      if (edge !== null) {
        if (edge < SETTLEMENT.reconcileMinBytes) {
          status = 'ok';
          gapPct = 0;
        } else {
          gapPct = Number((((edge - metered) / edge) * 100).toFixed(3));
          status = gapPct > SETTLEMENT.reconcileGapPct ? 'gap' : 'ok';
        }
      }
      const row = {
        day,
        metered_bytes: metered,
        edge_bytes: edge,
        gap_pct: gapPct,
        status,
      };
      await this.repo.upsertReconciliation(row);
      if (status === 'gap')
        this.logger.warn('Bandwidth reconciliation gap', {
          day,
          metered,
          edge,
          gapPct,
        });
      out.push(reconView({ ...row, checked_at: now }));
    }
    return out;
  }

  async reconciliationHistory(limit = 31): Promise<ReconciliationView[]> {
    const r = await this.repo.listReconciliation(limit);
    return (r.data ?? []).map(reconView);
  }

  // ── Period close: finalize last period once the grace window has passed ──
  /**
   * Writes one usage_periods row per active author for the previous billing
   * period, but only after period end + graceHours, so late log files are in.
   * Idempotent: authors already finalized are skipped.
   */
  async closePeriods(now = new Date()): Promise<{
    period: { start: string; end: string };
    closed: number;
    waitingUntil?: string;
  }> {
    const period = previousBillingPeriod(now);
    const settle = settlementFor(period, now);
    if (!settle.isFinal)
      return { period, closed: 0, waitingUntil: settle.finalizesAt };
    const authors =
      (await this.repo.authorsActiveInPeriod(period.start, period.end)).data ??
      [];
    const recon = (await this.repo.listReconciliation(40)).data ?? [];
    const inPeriod = recon.filter((r) => {
      const d = String(r.day).slice(0, 10);
      return d >= period.start && d < period.end;
    });
    const reconciliationStatus = inPeriod.length
      ? inPeriod.some((r) => r.status === 'gap')
        ? 'gap'
        : inPeriod.every((r) => r.status === 'ok')
          ? 'ok'
          : 'partial'
      : null;
    let closed = 0;
    for (const authorId of authors) {
      const done = await this.repo.periodFinalized(authorId, period.start);
      if (done.data) continue;
      const acct = (await this.repo.authorAccount(authorId)).data;
      const lastMoment = new Date(
        new Date(`${period.end}T00:00:00Z`).getTime() - 1,
      );
      const u = await this.forAuthor(
        authorId,
        acct?.meta ?? null,
        lastMoment,
        acct?.account_id ?? undefined,
      );
      const row: UsagePeriodRow = {
        author_id: authorId,
        account_id: acct?.account_id ?? null,
        period_start: period.start,
        period_end: period.end,
        plan_id: u.plan.id,
        storage_limit: u.plan.storageBytes,
        bandwidth_limit: u.plan.bandwidthBytesPerPeriod,
        storage_bytes: u.storageBytes,
        publish_storage_bytes: u.publish.storageBytes,
        sync_storage_bytes: u.sync.storageBytes,
        bandwidth_bytes: u.bandwidthBytes,
        publish_bandwidth_bytes: u.publish.bandwidthBytes,
        sync_transfer_bytes: u.sync.transferBytes,
        requests: u.requests,
        // grace: "over" is judged against the soft limit, not the plan line
        over_storage: u.budgets.storage.overSoft,
        over_bandwidth: u.budgets.bandwidth.overSoft,
        reconciliation_status: reconciliationStatus,
      };
      const r = await this.repo.insertPeriod(row);
      if (!r.error) closed += 1;
    }
    if (closed)
      this.logger.info('Billing periods finalized', {
        period,
        closed,
        reconciliationStatus,
      });
    return { period, closed };
  }

  async periodsForAuthor(authorId: string): Promise<PeriodView[]> {
    const r = await this.repo.periodsForAuthor(authorId);
    return (r.data ?? []).map(periodView);
  }

  edgeMetrics(): EdgeMetrics | null {
    return edgeMetricsFromEnv();
  }

  // ── Bandwidth ingestion (CloudFront standard logs) ──────────────────────
  /** Process every unseen log file once; returns how many files and bytes were ingested. */
  async ingest(source: LogSource): Promise<{
    files: number;
    bytes: number;
    requests: number;
    skipped: number;
  }> {
    const keys = await source.list();
    let files = 0,
      bytes = 0,
      requests = 0,
      skipped = 0;
    for (const key of keys) {
      const seen = await this.repo.ingestSeen(key);
      if (seen.data) continue;
      let raw: Buffer;
      try {
        raw = await source.read(key);
      } catch (err) {
        this.logger.error(
          `could not read log ${key}: ${(err as Error).message}`,
        );
        continue;
      }
      const totals = parseCloudFrontLog(raw);
      let fileBytes = 0,
        fileReqs = 0;
      for (const t of totals) {
        const resolved = await this.resolveHost(t.host);
        if (!resolved) {
          skipped += t.requests;
          continue;
        }
        await this.repo.addDaily(
          resolved.authorId,
          resolved.cruxId,
          t.day,
          t.bytes,
          t.requests,
        );
        fileBytes += t.bytes;
        fileReqs += t.requests;
      }
      await this.repo.markIngested(key, fileBytes, fileReqs);
      files += 1;
      bytes += fileBytes;
      requests += fileReqs;
    }
    this.lastIngest = new Date().toISOString();
    if (files)
      this.logger.info('Bandwidth ingested', {
        files,
        bytes,
        requests,
        skipped,
      });
    return { files, bytes, requests, skipped };
  }

  private async resolveHost(
    host: string,
  ): Promise<{ cruxId: string; authorId: string } | null> {
    const id = cruxIdFromPublishHost(host);
    if (id) {
      const author = await this.repo.authorForCrux(id);
      return author.data ? { cruxId: id, authorId: author.data } : null;
    }
    const custom = await this.repo.cruxForHostname(host);
    return custom.data
      ? { cruxId: custom.data.crux_id, authorId: custom.data.author_id }
      : null;
  }

  /** S3-backed log source from env (null when not configured). */
  s3LogSource(): LogSource | null {
    const bucket = process.env.AWS_CLOUDFRONT_LOG_BUCKET;
    if (
      !bucket ||
      !process.env.AWS_ACCESS_KEY_ID ||
      !process.env.AWS_SECRET_ACCESS_KEY
    )
      return null;
    const s3 = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
    const prefix = process.env.AWS_CLOUDFRONT_LOG_PREFIX || '';
    return {
      async list() {
        const keys: string[] = [];
        let token: string | undefined;
        do {
          const res = await s3.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              ContinuationToken: token,
            }),
          );
          for (const o of res.Contents ?? [])
            if (o.Key && /\.(gz|log|json|jsonl)$/i.test(o.Key))
              keys.push(o.Key);
          token = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (token);
        return keys.sort();
      },
      async read(key: string) {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        const chunks: Buffer[] = [];
        for await (const chunk of res.Body as AsyncIterable<Buffer>)
          chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
      },
    };
  }

  /** Start periodic ingestion when a log bucket is configured. */
  startScheduler(intervalMs = 15 * 60 * 1000): void {
    const source = this.s3LogSource();
    if (!source || this.ingestTimer) return;
    const run = async () => {
      try {
        await this.ingest(source);
      } catch (err) {
        this.logger.error(`ingest failed: ${(err as Error).message}`);
      }
      const metrics = this.edgeMetrics();
      if (metrics) {
        try {
          await this.reconcile(metrics);
        } catch (err) {
          this.logger.error(`reconcile failed: ${(err as Error).message}`);
        }
      }
      try {
        await this.closePeriods();
      } catch (err) {
        this.logger.error(`closePeriods failed: ${(err as Error).message}`);
      }
    };
    this.ingestTimer = setInterval(() => void run(), intervalMs);
    setTimeout(() => void run(), 10_000);
    this.logger.info('Bandwidth ingestion scheduled', { intervalMs });
  }

  stopScheduler(): void {
    if (this.ingestTimer) clearInterval(this.ingestTimer);
    this.ingestTimer = null;
  }
}
