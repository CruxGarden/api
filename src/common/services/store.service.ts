import * as fs from 'fs/promises';
import * as path from 'path';
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront';
import { Injectable } from '@nestjs/common';
import { LoggerService } from './logger.service';
interface S3Options {
  bucket?: string;
  client?: S3Client;
  data?: Buffer;
  key?: string;
}
export interface StoreOptions {
  path: string;
  data?: Buffer;
  namespace?: string;
  contentType?: string;
}

export interface DownloadResult {
  data: Buffer;
  metadata?: any;
}

@Injectable()
export class StoreService {
  private readonly logger: LoggerService;
  private readonly mockMode: boolean;
  private readonly s3Client: S3Client;
  private readonly cfClient: CloudFrontClient;
  private readonly defaultNamespace =
    process.env.AWS_S3_ARTIFACTS_BUCKET || 'artifacts.crux.garden';

  constructor(private readonly loggerService: LoggerService) {
    this.logger = this.loggerService.createChildLogger('StoreService');

    this.mockMode = !this.hasAwsCredentials();
    if (this.mockMode) {
      this.logger.warn(
        `AWS credentials not found - StoreService keeps files on this machine under ${this.localRoot()}`,
      );
    } else {
      const credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
      this.s3Client = new S3Client({
        region: process.env.AWS_REGION,
        credentials,
      });
      this.cfClient = new CloudFrontClient({
        region: process.env.AWS_REGION,
        credentials,
      });
    }
  }

  /**
   * Without AWS the store is a folder on this machine (LOCAL_STORE_DIR,
   * default `.local-storage/` in the API's working directory): a garden
   * running locally keeps its artifacts for real, so what one garden publishes
   * another can install (ADR 0049).
   */
  private localRoot(): string {
    return path.resolve(process.env.LOCAL_STORE_DIR || '.local-storage');
  }
  private localPath(bucket: string, key: string): string {
    const safe = key
      .split('/')
      .filter((s) => s && s !== '..')
      .join('/');
    return path.join(this.localRoot(), bucket, safe);
  }
  private async localKeys(bucket: string, prefix: string): Promise<string[]> {
    const root = path.join(this.localRoot(), bucket);
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const key = path.relative(root, full).split(path.sep).join('/');
          if (key.startsWith(prefix)) out.push(key);
        }
      }
    };
    await walk(root);
    return out;
  }

  private hasAwsCredentials(): boolean {
    return !!(
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_REGION &&
      process.env.AWS_S3_ARTIFACTS_BUCKET
    );
  }

  async download(opts: StoreOptions): Promise<DownloadResult> {
    if (this.mockMode) {
      const file = this.localPath(
        opts.namespace || this.defaultNamespace,
        opts.path,
      );
      const data = await fs.readFile(file);
      this.logger.info('File downloaded (local)', { path: opts.path });
      return { data, metadata: { ETag: 'local' } };
    }

    const s3Opts: S3Options = {
      bucket: opts.namespace || this.defaultNamespace,
      key: opts.path,
    };

    const res = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: s3Opts.bucket,
        Key: s3Opts.key,
      }),
    );

    // Convert stream to buffer
    const stream = res.Body as any;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    return {
      data: buffer,
      metadata: { ETag: res.ETag },
    };
  }

  async upload(opts: StoreOptions): Promise<void> {
    if (!opts.data) {
      throw new Error('Data is required for upload');
    }

    if (this.mockMode) {
      const file = this.localPath(
        opts.namespace || this.defaultNamespace,
        opts.path,
      );
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, opts.data);
      this.logger.info('File uploaded (local)', {
        path: opts.path,
        size: `${opts.data.length} bytes`,
      });
      return;
    }

    const s3Opts: S3Options = {
      bucket: opts.namespace || this.defaultNamespace,
      key: opts.path,
      data: opts.data,
    };

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: s3Opts.bucket,
        Key: s3Opts.key,
        Body: s3Opts.data,
        ...(opts.contentType ? { ContentType: opts.contentType } : {}),
      }),
    );
  }

  async copy(opts: {
    sourcePath: string;
    destPath: string;
    namespace?: string;
  }): Promise<void> {
    const bucket = opts.namespace || this.defaultNamespace;

    if (this.mockMode) {
      const dest = this.localPath(bucket, opts.destPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(this.localPath(bucket, opts.sourcePath), dest);
      this.logger.info('File copied (local)', {
        source: opts.sourcePath,
        dest: opts.destPath,
      });
      return;
    }

    await this.s3Client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${opts.sourcePath}`,
        Key: opts.destPath,
      }),
    );
  }

  async delete(opts: StoreOptions): Promise<void> {
    if (this.mockMode) {
      await fs
        .rm(
          this.localPath(opts.namespace || this.defaultNamespace, opts.path),
          { force: true },
        )
        .catch(() => undefined);
      this.logger.info('File deleted (local)', { path: opts.path });
      return;
    }

    const s3Opts: S3Options = {
      bucket: opts.namespace || this.defaultNamespace,
      key: opts.path,
    };

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: s3Opts.bucket,
        Key: s3Opts.key,
      }),
    );
  }

  async deleteByPrefix(opts: {
    prefix: string;
    namespace?: string;
  }): Promise<number> {
    const bucket = opts.namespace || this.defaultNamespace;

    if (this.mockMode) {
      const keys = await this.localKeys(bucket, opts.prefix);
      for (const key of keys)
        await fs.rm(this.localPath(bucket, key), { force: true });
      this.logger.info('Files deleted by prefix (local)', {
        prefix: opts.prefix,
        count: keys.length,
      });
      return keys.length;
    }

    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      const list = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: opts.prefix,
          ContinuationToken: continuationToken,
        }),
      );

      const objects = list.Contents;
      if (!objects || objects.length === 0) break;

      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: objects.map((o) => ({ Key: o.Key })),
            Quiet: true,
          },
        }),
      );

      deleted += objects.length;
      continuationToken = list.IsTruncated
        ? list.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return deleted;
  }

  async movePrefix(opts: {
    oldPrefix: string;
    newPrefix: string;
    namespace?: string;
  }): Promise<number> {
    const bucket = opts.namespace || this.defaultNamespace;

    if (this.mockMode) {
      const keys = await this.localKeys(bucket, opts.oldPrefix);
      for (const key of keys) {
        const dest = this.localPath(
          bucket,
          opts.newPrefix + key.slice(opts.oldPrefix.length),
        );
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(this.localPath(bucket, key), dest);
      }
      this.logger.info('Files moved by prefix (local)', {
        oldPrefix: opts.oldPrefix,
        newPrefix: opts.newPrefix,
        count: keys.length,
      });
      return keys.length;
    }

    let moved = 0;
    let continuationToken: string | undefined;

    do {
      const list = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: opts.oldPrefix,
          ContinuationToken: continuationToken,
        }),
      );

      const objects = list.Contents;
      if (!objects || objects.length === 0) break;

      // Copy each object to new prefix
      for (const obj of objects) {
        const newKey = obj.Key!.replace(opts.oldPrefix, opts.newPrefix);
        await this.s3Client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: `${bucket}/${obj.Key}`,
            Key: newKey,
          }),
        );
      }

      // Delete old objects
      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: objects.map((o) => ({ Key: o.Key })),
            Quiet: true,
          },
        }),
      );

      moved += objects.length;
      continuationToken = list.IsTruncated
        ? list.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return moved;
  }

  async invalidateCache(opts: {
    paths: string[];
    distributionId?: string;
  }): Promise<void> {
    const distributionId =
      opts.distributionId || process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID;

    if (!distributionId) {
      this.logger.warn(
        'CloudFront distribution ID not configured — skipping cache invalidation',
      );
      return;
    }

    if (this.mockMode) {
      this.logger.info('CloudFront invalidation (mock)', {
        distributionId,
        paths: opts.paths,
      });
      return;
    }

    await this.cfClient.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          Paths: {
            Quantity: opts.paths.length,
            Items: opts.paths,
          },
        },
      }),
    );

    this.logger.info('CloudFront cache invalidation submitted', {
      distributionId,
      paths: opts.paths,
    });
  }
}
