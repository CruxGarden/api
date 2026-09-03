import { Injectable, NotFoundException } from '@nestjs/common';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { LoggerService } from '../common/services/logger.service';
import { UsageRepository, type UsageSyncDailyRow } from './usage.repository';
import { parseCloudFrontLog, cruxIdFromPublishHost } from './cloudfront-logs';
import { billingPeriod, planFor, type Plan } from './plans';

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

export interface AccountUsage {
  period: { start: string; end: string };
  plan: Plan;
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
    const [storage, daily, sync] = await Promise.all([
      this.repo.storageByAuthor(authorId),
      this.repo.dailyByAuthor(authorId, period.start, period.end),
      accountId
        ? this.syncForAccount(accountId, period)
        : Promise.resolve(emptySync()),
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
    return {
      period,
      plan: planFor(authorMeta),
      storageBytes: publish.storageBytes + sync.storageBytes,
      bandwidthBytes: publish.bandwidthBytes + sync.transferBytes,
      requests: publish.requests,
      publish,
      cruxes,
      sync,
      bandwidthAsOf: this.lastIngest,
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
            if (o.Key?.endsWith('.gz')) keys.push(o.Key);
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
    const run = () =>
      this.ingest(source).catch((err) =>
        this.logger.error(`ingest failed: ${(err as Error).message}`),
      );
    this.ingestTimer = setInterval(run, intervalMs);
    setTimeout(run, 10_000);
    this.logger.info('Bandwidth ingestion scheduled', { intervalMs });
  }

  stopScheduler(): void {
    if (this.ingestTimer) clearInterval(this.ingestTimer);
    this.ingestTimer = null;
  }
}
