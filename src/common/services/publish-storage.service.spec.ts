import { Test } from '@nestjs/testing';
import {
  PublishStorageService,
  isHashedAsset,
} from './publish-storage.service';
import { LoggerService } from './logger.service';

const logger = {
  createChildLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
} as never;

describe('PublishStorageService', () => {
  const env = { ...process.env };

  it('resolves through Nest without an S3Client provider (the API must boot)', async () => {
    // The optional S3 client exists for tests; the real graph has no provider
    // for it. This once made every NestFactory.create fail before listen().
    const mod = await Test.createTestingModule({
      providers: [PublishStorageService, LoggerService],
    }).compile();
    expect(mod.get(PublishStorageService)).toBeInstanceOf(
      PublishStorageService,
    );
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('only content-hashed build output is treated as immutable', () => {
    expect(isHashedAsset('_astro/index.Bx7f9Kq2.css')).toBe(true);
    expect(isHashedAsset('assets/app-C3kd82ls.js')).toBe(true);
    expect(isHashedAsset('_astro/hero.a1b2c3d4e5.webp')).toBe(true);
    expect(isHashedAsset('style.css')).toBe(false);
    expect(isHashedAsset('images/photo.jpg')).toBe(false);
    expect(isHashedAsset('assets/logo.svg')).toBe(false);
  });

  it('names buckets and website endpoints from the crux id', () => {
    process.env.AWS_REGION = 'us-west-2';
    process.env.PUBLISH_BUCKET_PREFIX = 'crux-';
    delete process.env.AWS_ACCESS_KEY_ID;
    const svc = new PublishStorageService(logger);
    expect(svc.mockMode).toBe(true);
    expect(svc.bucketName('ABC')).toBe('crux-abc');
    expect(svc.websiteEndpoint('abc')).toBe(
      'crux-abc.s3-website-us-west-2.amazonaws.com',
    );
  });

  it('bucket policy requires the origin secret as Referer', () => {
    process.env.PUBLISH_ORIGIN_SECRET = 'top-secret';
    const svc = new PublishStorageService(logger);
    const policy = JSON.parse(svc.bucketPolicy('crux-x'));
    expect(policy.Statement[0].Action).toBe('s3:GetObject');
    expect(policy.Statement[0].Condition).toEqual({
      StringEquals: { 'aws:Referer': 'top-secret' },
    });
    process.env.PUBLISH_ORIGIN_SECRET = '';
    expect(
      JSON.parse(new PublishStorageService(logger).bucketPolicy('b'))
        .Statement[0].Condition,
    ).toBeUndefined();
  });

  it('mock mode publishes, replaces stale files, and deletes', async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    const svc = new PublishStorageService(logger);
    await svc.ensureBucket('c1', 'a1');
    const r = await svc.putFiles('c1', [
      {
        path: 'index.html',
        data: Buffer.from('<h1>hi</h1>'),
        contentType: 'text/html',
      },
      { path: 'a.css', data: Buffer.alloc(10), contentType: 'text/css' },
    ]);
    expect(r).toEqual({ bytes: 21, files: 2 });
    expect(await svc.downloadFile('c1', 'index.html')).toEqual(
      Buffer.from('<h1>hi</h1>'),
    );
    await expect(svc.downloadFile('c1', 'missing.zip')).rejects.toThrow();
    expect(Object.keys(svc.mockContents('c1')!)).toEqual([
      'index.html',
      'a.css',
    ]);
    await svc.putFiles('c1', [
      { path: 'index.html', data: Buffer.alloc(3), contentType: 'text/html' },
    ]);
    expect(Object.keys(svc.mockContents('c1')!)).toEqual(['index.html']);
    await svc.deleteBucket('c1');
    expect(svc.mockContents('c1')).toBeNull();
  });
});

describe('Bucket teardown failures', () => {
  it.each([403, 500])(
    'does not treat a HeadBucket %s as an absent bucket',
    async (status) => {
      const error = Object.assign(new Error('Storage unavailable'), {
        $metadata: { httpStatusCode: status },
      });
      const send = jest.fn().mockRejectedValue(error);
      const svc = new PublishStorageService(logger, { send } as never);
      await expect(svc.deleteBucket('c1')).rejects.toBe(error);
    },
  );
  it('accepts an absent bucket and can retry a partially refused object deletion', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    const svc = new PublishStorageService(logger, { send } as never);
    await expect(svc.deleteBucket('c1')).resolves.toBeUndefined();
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Contents: [{ Key: 'index.html' }] })
      .mockResolvedValueOnce({
        Errors: [{ Key: 'index.html', Code: 'AccessDenied' }],
      });
    await expect(svc.deleteBucket('c1')).rejects.toThrow(/delete/i);
    expect(
      send.mock.calls.map(([command]) => command.constructor.name),
    ).not.toContain('DeleteBucketCommand');
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Contents: [{ Key: 'index.html' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    await expect(svc.deleteBucket('c1')).resolves.toBeUndefined();
  });
});

describe('Publication upload failure', () => {
  it('drains in-flight writes before reporting refusal so cleanup cannot race a late write', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const send = jest.fn(async (command) => {
      if (command.input.Key === 'refused.css')
        throw new Error('Upload refused');
      entered();
      await delayed;
      return {};
    });
    const svc = new PublishStorageService(logger, { send } as never);
    let settled = false;
    const upload = svc
      .putFiles('staged', [
        {
          path: 'refused.css',
          data: Buffer.from('x'),
          contentType: 'text/css',
        },
        { path: 'slow.html', data: Buffer.from('x'), contentType: 'text/html' },
      ])
      .catch((error) => {
        settled = true;
        return error;
      });
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    expect(await upload).toEqual(new Error('Upload refused'));
  });
});
