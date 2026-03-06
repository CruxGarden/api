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
    process.env.AWS_S3_ATTACHMENTS_BUCKET || 'crux-garden-attachments';

  constructor(private readonly loggerService: LoggerService) {
    this.logger = this.loggerService.createChildLogger('StoreService');

    this.mockMode = !this.hasAwsCredentials();
    if (this.mockMode) {
      this.logger.warn(
        'AWS credentials not found - StoreService running in mock mode (logging only)',
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

  private hasAwsCredentials(): boolean {
    return !!(
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_REGION &&
      process.env.AWS_S3_ATTACHMENTS_BUCKET
    );
  }

  async download(opts: StoreOptions): Promise<DownloadResult> {
    if (this.mockMode) {
      this.logger.info('File downloaded', {
        bucket: opts.namespace || this.defaultNamespace,
        path: opts.path,
      });
      return {
        data: Buffer.from('mock-file-data'),
        metadata: { ETag: 'mock-etag' },
      };
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
      this.logger.info('File uploaded', {
        bucket: opts.namespace || this.defaultNamespace,
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
      this.logger.info('File copied', {
        bucket,
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
      this.logger.info('File deleted', {
        bucket: opts.namespace || this.defaultNamespace,
        path: opts.path,
      });
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
      this.logger.info('Files deleted by prefix', {
        bucket,
        prefix: opts.prefix,
      });
      return 0;
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
      this.logger.info('Files moved by prefix', {
        bucket,
        oldPrefix: opts.oldPrefix,
        newPrefix: opts.newPrefix,
      });
      return 0;
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
