import { StoreService } from '../common/services/store.service';
import { recoveryStorageConfiguration } from './sync-upload-recovery';

describe('explicit maintenance storage ownership', () => {
  const s3 = {
    AWS_S3_SYNC_BUCKET: 'actual-sync',
    AWS_S3_ARTIFACTS_BUCKET: 'actual-artifacts',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'fixture-only',
    AWS_SECRET_ACCESS_KEY: 'fixture-only',
  };
  const local = {
    AWS_S3_SYNC_BUCKET: 'local-sync',
    LOCAL_STORE_DIR: '/tmp/operator-owned-fixture',
  };
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });
  it.each(Object.keys(s3))(
    'refuses S3 recovery with missing %s before constructing an automatic-fallback store',
    (key) => {
      const incomplete: NodeJS.ProcessEnv = { ...s3 };
      delete incomplete[key];
      expect(() => recoveryStorageConfiguration('s3', incomplete)).toThrow();
    },
  );
  it('requires an explicit backend and absolute local root without competing credentials', () => {
    expect(() => recoveryStorageConfiguration(undefined, local)).toThrow(
      'Choose',
    );
    expect(() =>
      recoveryStorageConfiguration('local', {
        ...local,
        LOCAL_STORE_DIR: 'relative',
      }),
    ).toThrow('absolute');
    expect(() =>
      recoveryStorageConfiguration('local', {
        ...local,
        AWS_ACCESS_KEY_ID: 'fixture-only',
      }),
    ).toThrow('refuses AWS');
  });
  it('reports the actual non-secret backend configuration selected by StoreService', () => {
    const logger = { createChildLogger: () => ({ warn: jest.fn() }) } as never;
    process.env = { ...s3 };
    expect(recoveryStorageConfiguration('s3', process.env)).toEqual({
      backend: 's3',
      bucket: 'actual-sync',
      region: 'us-east-1',
    });
    expect(
      (new StoreService(logger) as unknown as { mockMode: boolean }).mockMode,
    ).toBe(false);
    process.env = { ...local };
    expect(recoveryStorageConfiguration('local', process.env)).toEqual({
      backend: 'local',
      bucket: 'local-sync',
      root: local.LOCAL_STORE_DIR,
    });
    expect(
      (new StoreService(logger) as unknown as { mockMode: boolean }).mockMode,
    ).toBe(true);
  });
});
