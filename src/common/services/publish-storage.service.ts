import { Injectable } from '@nestjs/common';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketWebsiteCommand,
  PutPublicAccessBlockCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import { LoggerService } from './logger.service';

/**
 * Publish v2 storage (ADR 0011): one S3 bucket per published crux, served as
 * a website endpoint behind CloudFront. The bucket policy only admits reads
 * carrying the origin secret in `Referer`, so the raw bucket is a 403 and
 * every visit goes through crux.garden's edge.
 *
 * Mock mode (no AWS credentials) logs and remembers the objects in memory so
 * publish/unpublish stay exercisable in tests and the nursery.
 */
export interface PublishFile {
  path: string;
  data: Buffer;
  contentType: string;
}

export interface PublishStorageConfig {
  region: string;
  bucketPrefix: string;
  originSecret: string;
}

@Injectable()
export class PublishStorageService {
  private readonly logger: LoggerService;
  private readonly s3?: S3Client;
  readonly mockMode: boolean;
  readonly config: PublishStorageConfig;
  /** mock mode only: bucket → set of keys */
  private readonly mockBuckets = new Map<string, Map<string, number>>();

  constructor(loggerService: LoggerService, s3?: S3Client) {
    this.logger = loggerService.createChildLogger('PublishStorageService');
    this.config = {
      region: process.env.AWS_REGION || 'us-east-1',
      bucketPrefix: process.env.PUBLISH_BUCKET_PREFIX || 'crux-',
      originSecret: process.env.PUBLISH_ORIGIN_SECRET || '',
    };
    const hasCreds = !!(
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_REGION
    );
    this.mockMode = !s3 && !hasCreds;
    if (this.mockMode && process.env.NODE_ENV === 'production')
      throw new Error(
        'PublishStorageService: AWS credentials missing in production — publishing would silently go nowhere',
      );
    if (s3) this.s3 = s3;
    else if (!this.mockMode) {
      this.s3 = new S3Client({
        region: this.config.region,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
      });
    } else {
      this.logger.warn(
        'PublishStorageService in mock mode (no AWS credentials) — buckets are in-memory',
      );
    }
    if (!this.mockMode && !this.config.originSecret) {
      this.logger.warn(
        'PUBLISH_ORIGIN_SECRET is empty — published buckets will be publicly readable',
      );
    }
  }

  /** `crux-{cruxId}` — a UUID is a valid, globally unique bucket name. */
  bucketName(cruxId: string): string {
    return `${this.config.bucketPrefix}${cruxId}`.toLowerCase();
  }

  /** Website endpoint the edge uses as the origin. */
  websiteEndpoint(cruxId: string): string {
    return `${this.bucketName(cruxId)}.s3-website-${this.config.region}.amazonaws.com`;
  }

  /** The bucket policy: public reads only with the origin secret as Referer. */
  bucketPolicy(bucket: string): string {
    const statement: Record<string, unknown> = {
      Sid: 'CruxGardenEdgeOnly',
      Effect: 'Allow',
      Principal: '*',
      Action: 's3:GetObject',
      Resource: `arn:aws:s3:::${bucket}/*`,
    };
    if (this.config.originSecret) {
      statement.Condition = {
        StringEquals: { 'aws:Referer': this.config.originSecret },
      };
    }
    return JSON.stringify({ Version: '2012-10-17', Statement: [statement] });
  }

  /** Create the crux's bucket if needed and (re)apply website config, policy, tags. Idempotent. */
  async ensureBucket(cruxId: string, authorId: string): Promise<string> {
    const bucket = this.bucketName(cruxId);
    if (this.mockMode) {
      if (!this.mockBuckets.has(bucket))
        this.mockBuckets.set(bucket, new Map());
      this.logger.info('Bucket ensured (mock)', { bucket, authorId });
      return bucket;
    }
    const s3 = this.s3!;
    let exists = true;
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      exists = false;
    }
    if (!exists) {
      await s3.send(
        new CreateBucketCommand({
          Bucket: bucket,
          // us-east-1 rejects an explicit LocationConstraint
          ...(this.config.region !== 'us-east-1'
            ? {
                CreateBucketConfiguration: {
                  LocationConstraint: this.config.region as never,
                },
              }
            : {}),
        }),
      );
    }
    await s3.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: false,
          RestrictPublicBuckets: false,
        },
      }),
    );
    await s3.send(
      new PutBucketWebsiteCommand({
        Bucket: bucket,
        WebsiteConfiguration: {
          IndexDocument: { Suffix: 'index.html' },
          ErrorDocument: { Key: '404.html' },
        },
      }),
    );
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: this.bucketPolicy(bucket),
      }),
    );
    await s3.send(
      new PutBucketTaggingCommand({
        Bucket: bucket,
        Tagging: {
          TagSet: [
            { Key: 'crux-garden:author', Value: authorId },
            { Key: 'crux-garden:crux', Value: cruxId },
            { Key: 'crux-garden:role', Value: 'publish' },
          ],
        },
      }),
    );
    this.logger.info(exists ? 'Bucket refreshed' : 'Bucket created', {
      bucket,
      authorId,
    });
    return bucket;
  }

  /** Write the published files; delete objects that are no longer part of the site. */
  async putFiles(
    cruxId: string,
    files: PublishFile[],
  ): Promise<{ bytes: number; files: number }> {
    const bucket = this.bucketName(cruxId);
    const bytes = files.reduce((n, f) => n + f.data.length, 0);
    if (this.mockMode) {
      const keys = new Map<string, number>();
      for (const f of files) keys.set(f.path, f.data.length);
      this.mockBuckets.set(bucket, keys);
      this.logger.info('Files published (mock)', {
        bucket,
        files: files.length,
        bytes,
      });
      return { bytes, files: files.length };
    }
    const s3 = this.s3!;
    const wanted = new Set(files.map((f) => f.path));
    // Only content-hashed build output may be cached for a year; a plain crux's
    // style.css must revalidate or visitors keep the old file after a republish.
    const cacheControl = (path: string) =>
      path.endsWith('.html')
        ? 'public, max-age=0, must-revalidate'
        : isHashedAsset(path)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300, must-revalidate';
    // Bounded concurrency: a large site must not open thousands of connections.
    const queue = [...files];
    const workers = Array.from(
      { length: Math.min(16, queue.length) },
      async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: f.path,
              Body: f.data,
              ContentType: f.contentType,
              CacheControl: cacheControl(f.path),
            }),
          );
        }
      },
    );
    await Promise.all(workers);
    const stale = (await this.listKeys(bucket)).filter((k) => !wanted.has(k));
    if (stale.length) await this.deleteKeys(bucket, stale);
    this.logger.info('Files published', {
      bucket,
      files: files.length,
      bytes,
      removed: stale.length,
    });
    return { bytes, files: files.length };
  }

  /** Empty and delete the crux's bucket (unpublish). Idempotent. */
  async deleteBucket(cruxId: string): Promise<void> {
    const bucket = this.bucketName(cruxId);
    if (this.mockMode) {
      this.mockBuckets.delete(bucket);
      this.logger.info('Bucket deleted (mock)', { bucket });
      return;
    }
    const s3 = this.s3!;
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      return; // already gone
    }
    const keys = await this.listKeys(bucket);
    if (keys.length) await this.deleteKeys(bucket, keys);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    this.logger.info('Bucket deleted', { bucket, objects: keys.length });
  }

  /** mock mode: what's in a bucket (tests) */
  mockContents(cruxId: string): Record<string, number> | null {
    const m = this.mockBuckets.get(this.bucketName(cruxId));
    return m ? Object.fromEntries(m) : null;
  }

  private async listKeys(bucket: string): Promise<string[]> {
    const s3 = this.s3!;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  private async deleteKeys(bucket: string, keys: string[]): Promise<void> {
    const s3 = this.s3!;
    for (let i = 0; i < keys.length; i += 1000) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }
  }
}

/** Vite/Astro emit hashed filenames under _astro/ or assets/ (name.[hash].ext or name-[hash].ext). */
export function isHashedAsset(path: string): boolean {
  return /(^|\/)(_astro|assets)\/[^/]+[.-][A-Za-z0-9_]{6,}\.[a-z0-9]+$/i.test(
    path,
  );
}
