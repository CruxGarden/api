import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';

const defaultS3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Internal S3-specific options
interface S3Options {
  bucket?: string;
  client?: S3Client;
  data?: Buffer;
  key?: string;
}

// Public storage-agnostic interface
export interface StoreOptions {
  path: string;
  data?: Buffer;
  namespace?: string; // Optional namespace (defaults to env-specific bucket)
}

export interface DownloadResult {
  data: Buffer;
  metadata?: any;
}

@Injectable()
export class StoreService {
  private readonly defaultNamespace =
    process.env.AWS_S3_ATTACHMENTS_BUCKET || 'crux-garden-attachments';

  /**
   * Download a file from storage
   */
  async download(opts: StoreOptions): Promise<DownloadResult> {
    const s3Opts: S3Options = {
      bucket: opts.namespace || this.defaultNamespace,
      key: opts.path,
    };

    const client = defaultS3Client;
    const res = await client.send(
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

  /**
   * Upload a file to storage
   */
  async upload(opts: StoreOptions): Promise<void> {
    if (!opts.data) {
      throw new Error('Data is required for upload');
    }

    const s3Opts: S3Options = {
      bucket: opts.namespace || this.defaultNamespace,
      key: opts.path,
      data: opts.data,
    };

    const client = defaultS3Client;
    await client.send(
      new PutObjectCommand({
        Bucket: s3Opts.bucket,
        Key: s3Opts.key,
        Body: s3Opts.data,
      }),
    );
  }

  /**
   * Delete a file from storage
   */
  async delete(opts: StoreOptions): Promise<void> {
    const s3Opts: S3Options = {
      bucket: opts.namespace || this.defaultNamespace,
      key: opts.path,
    };

    const client = defaultS3Client;
    await client.send(
      new DeleteObjectCommand({
        Bucket: s3Opts.bucket,
        Key: s3Opts.key,
      }),
    );
  }
}
