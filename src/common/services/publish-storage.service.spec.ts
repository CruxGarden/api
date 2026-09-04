import {
  PublishStorageService,
  isHashedAsset,
} from './publish-storage.service';

const logger = {
  createChildLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
} as never;

describe('PublishStorageService', () => {
  const env = { ...process.env };
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
