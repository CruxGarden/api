import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
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
      this.s3Client = new S3Client({
        region: process.env.AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
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
}
