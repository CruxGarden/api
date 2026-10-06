import * as JSZip from 'jszip';
import { CruxService } from './crux.service';
import Crux from './entities/crux.entity';
import { TOOL_PACKAGE_PATH } from '../common/publish/tool-package';
import { publicCruxMeta } from '../common/publish/public-meta';

async function packageUpload() {
  const zip = new JSZip();
  zip.file('files/runtime/index.html', '<h1>Editor</h1>', {
    createFolders: false,
  });
  zip.file(
    'tool-package.json',
    JSON.stringify({
      format: 'crux-tool',
      version: 1,
      tool: {
        id: 'p5-app',
        name: 'Sketch',
        releaseVersion: '1.0.0',
        entryFile: 'runtime/index.html',
        toolInfo: { upstream: 'https://github.com/processing/p5.js' },
        greeting: 'stays private',
      },
      files: [{ path: 'runtime/index.html', size: 15, mimeType: 'text/html' }],
    }),
  );
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return {
    buffer,
    size: buffer.length,
    mimetype: 'application/zip',
    originalname: 'tool-package.zip',
  } as Express.Multer.File;
}
function fixture(layout: 'shared' | 'bucket-per-crux') {
  const crux = new Crux({
    id: 'c1',
    authorId: 'a1',
    homeId: 'h1',
    kind: 'tool',
    meta: {
      template: 'p5-app',
      publishedAt: 'before',
      publishedVersion: 1,
      publishLayout: layout,
    },
  });
  const repository = {
    findActiveTakedown: jest.fn(async () => ({ data: undefined, error: null })),
    findAuthorUsername: jest.fn(async () => ({ data: 'ada', error: null })),
    commitPublication: jest.fn(
      async (_id, _author, _version, _artifacts, meta) => ({
        data: { ...crux, meta },
        error: null,
      }),
    ),
  };
  const artifact = {
    deleteWorkingArtifactsByResource: jest.fn(),
    deleteSnapshotArtifacts: jest.fn(),
    deleteFromStaticBucket: jest.fn(),
    describePublishedArtifact: jest.fn((_id, _home, _author, file, meta) => ({
      id: 'archive-artifact',
      resourceType: 'crux',
      resourceId: 'c1',
      filename: file.originalname,
      mimeType: file.mimetype,
      meta,
    })),
    preparePublishFiles: jest.fn((files) =>
      files.map((f) => ({
        path: f.path,
        data: f.buffer,
        contentType: f.mimeType,
      })),
    ),
    uploadPreparedPublication: jest.fn(),
    findById: jest.fn(async () => ({
      id: 'archive-artifact',
      resourceType: 'crux',
      resourceId: 'c1',
      filename: 'tool-package.zip',
      mimeType: 'application/zip',
      meta: { path: TOOL_PACKAGE_PATH },
    })),
    downloadArtifact: jest.fn(async () => {
      throw new Error('No working copy');
    }),
  };
  const store = {
    invalidateCache: jest.fn(async () => undefined),
    download: jest.fn(async () => ({ data: Buffer.from('shared') })),
  };
  const storage = {
    ensureBucket: jest.fn(),
    putFiles: jest.fn(async (_id, files) => ({
      bytes: files[0].data.length,
      files: files.length,
    })),
    downloadFile: jest.fn(async () => Buffer.from('per-crux')),
  };
  const usage = {
    forCrux: jest.fn(async () => null),
    recordStorage: jest.fn(),
  };
  const service = new CruxService(
    repository as never,
    {} as never,
    {
      createChildLogger: () => ({ error: jest.fn(), warn: jest.fn() }),
    } as never,
    {} as never,
    {} as never,
    artifact as never,
    store as never,
    storage as never,
    usage as never,
    {
      assertStorage: jest.fn(async () => ({
        used: 3 * 1024 ** 3,
        limit: 2 * 1024 ** 3,
        softLimit: 2.4 * 1024 ** 3,
        warn: true,
      })),
    } as never,
    { afterWrite: jest.fn().mockResolvedValue([]) } as never,
    {
      activatePublication: jest.fn().mockResolvedValue(undefined),
      assertPublicationLayout: jest.fn().mockResolvedValue(undefined),
    } as never,
  );
  jest.spyOn(service, 'findById').mockResolvedValue(crux);
  return { service, artifact, store, storage, usage, repository };
}

describe('single-package tool publication', () => {
  const previous = process.env.PUBLISH_LAYOUT;
  const previousRouting = process.env.PUBLISH_REVISION_ROUTING;
  beforeEach(() => {
    process.env.PUBLISH_REVISION_ROUTING = '1';
  });
  afterEach(() => {
    if (previousRouting === undefined)
      delete process.env.PUBLISH_REVISION_ROUTING;
    else process.env.PUBLISH_REVISION_ROUTING = previousRouting;
    if (previous === undefined) delete process.env.PUBLISH_LAYOUT;
    else process.env.PUBLISH_LAYOUT = previous;
  });
  it.each(['shared', 'bucket-per-crux'] as const)(
    'stores one Artifact/object and exposes its downloadable version in %s layout',
    async (layout) => {
      process.env.PUBLISH_LAYOUT = layout;
      const f = fixture(layout);
      const file = await packageUpload();
      const result = await f.service.publishCrux(
        'c1',
        [file],
        [{ path: TOOL_PACKAGE_PATH }],
        'a1',
      );
      expect(f.artifact.describePublishedArtifact).toHaveBeenCalledTimes(1);
      if (layout === 'shared')
        expect(
          f.artifact.uploadPreparedPublication.mock.calls[0][0],
        ).toHaveLength(1);
      else
        expect(f.storage.putFiles.mock.calls[0][1]).toEqual([
          {
            path: TOOL_PACKAGE_PATH,
            data: file.buffer,
            contentType: 'application/zip',
          },
        ]);
      expect(f.repository.commitPublication).toHaveBeenCalledWith(
        'c1',
        'a1',
        1,
        expect.any(Array),
        expect.objectContaining({
          publishedBytes: file.size,
          publishStorageId: expect.any(String),
        }),
        [],
      );
      expect(publicCruxMeta(result.meta)?.toolPackage).toMatchObject({
        artifactId: 'archive-artifact',
        fileCount: 1,
        size: file.size,
        unpackedBytes: 15,
      });
      // ADR 0084: the trust summary comes from the validated package header.
      expect(publicCruxMeta(result.meta)?.toolSummary).toEqual({
        name: 'Sketch',
        version: '1.0.0',
        publisher: 'ada',
        upstreamUrl: 'https://github.com/processing/p5.js',
        sizeBytes: file.size,
        permissions: [],
        sandboxed: true,
      });
      expect(JSON.stringify(publicCruxMeta(result.meta))).not.toContain(
        'stays private',
      );
      // The soft-limit warning reaches the publish answer.
      expect(result.warnings).toEqual([
        expect.objectContaining({
          kind: 'storage_soft_limit',
          usedBytes: 3 * 1024 ** 3,
          limitBytes: 2 * 1024 ** 3,
        }),
      ]);
      jest.spyOn(f.service, 'findById').mockResolvedValue(result);
      // Retrieval follows the recorded layout even if the current deployment default changed.
      process.env.PUBLISH_LAYOUT =
        layout === 'shared' ? 'bucket-per-crux' : 'shared';
      expect(
        (
          await f.service.downloadArtifact('c1', 'archive-artifact')
        ).data.toString(),
      ).toBe(layout === 'shared' ? 'shared' : 'per-crux');
      expect(f.artifact.downloadArtifact).not.toHaveBeenCalled();
    },
  );
  it('rejects a corrupt archive before deleting a previous publication', async () => {
    const f = fixture('shared');
    const file = await packageUpload();
    file.buffer = Buffer.from('not a zip');
    await expect(
      f.service.publishCrux('c1', [file], [{ path: TOOL_PACKAGE_PATH }], 'a1'),
    ).rejects.toThrow(/Invalid Crux Tool package/);
    expect(f.artifact.deleteWorkingArtifactsByResource).not.toHaveBeenCalled();
    expect(f.repository.commitPublication).not.toHaveBeenCalled();
  });
  it('rejects legacy loose tool files before deleting a previous publication', async () => {
    const f = fixture('shared');
    await expect(
      f.service.publishCrux(
        'c1',
        [await packageUpload()],
        [{ path: 'runtime/index.html' }],
        'a1',
      ),
    ).rejects.toThrow(/one package/);
    expect(f.artifact.deleteWorkingArtifactsByResource).not.toHaveBeenCalled();
  });
});
