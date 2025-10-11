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

export interface S3Options {
  bucket?: string;
  client?: S3Client;
  data?: Buffer;
  key?: string;
}

@Injectable()
export class StoreService {
  async download(opts: S3Options) {
    const client = opts.client || defaultS3Client;
    const res = await client.send(
      new GetObjectCommand({
        Bucket: opts.bucket,
        Key: opts.key,
      }),
    );

    return { Body: res.Body, ETag: res.ETag };
  }

  async upload(opts: S3Options) {
    const client = opts.client || defaultS3Client;
    const res = await client.send(
      new PutObjectCommand({
        Bucket: opts.bucket,
        Key: opts.key,
        Body: opts.data,
      }),
    );

    return { ETag: res.ETag };
  }

  async delete(opts: S3Options) {
    const client = opts.client || defaultS3Client;
    await client.send(
      new DeleteObjectCommand({
        Bucket: opts.bucket,
        Key: opts.key,
      }),
    );

    return true;
  }
}
