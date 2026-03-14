import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SyncService } from './sync.service';
import { StoreService } from '../common/services/store.service';
import { LoggerService } from '../common/services/logger.service';

describe('SyncService', () => {
  let service: SyncService;
  let storeService: jest.Mocked<StoreService>;

  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    createChildLogger: jest.fn().mockReturnThis(),
  };

  const accountId = 'account-123';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        {
          provide: StoreService,
          useValue: {
            upload: jest.fn(),
            download: jest.fn(),
            delete: jest.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: mockLogger,
        },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
    storeService = module.get(StoreService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('pushGarden', () => {
    it('should upload garden ZIP and meta to S3', async () => {
      const data = Buffer.from('garden-zip-data');
      const result = await service.pushGarden(accountId, data);

      expect(storeService.upload).toHaveBeenCalledTimes(2);
      expect(storeService.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          path: `sync/${accountId}/garden.zip`,
          data,
          contentType: 'application/zip',
        }),
      );
      expect(storeService.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          path: `sync/${accountId}/garden-meta.json`,
          contentType: 'application/json',
        }),
      );
      expect(result.syncedAt).toBeDefined();
      expect(result.size).toBe(data.length);
    });
  });

  describe('pullGarden', () => {
    it('should download garden ZIP from S3', async () => {
      const gardenData = Buffer.from('garden-zip');
      storeService.download.mockResolvedValue({
        data: gardenData,
        metadata: {},
      });

      const result = await service.pullGarden(accountId);
      expect(result).toEqual(gardenData);
      expect(storeService.download).toHaveBeenCalledWith(
        expect.objectContaining({
          path: `sync/${accountId}/garden.zip`,
        }),
      );
    });

    it('should throw NotFoundException when no garden exists', async () => {
      storeService.download.mockRejectedValue(new Error('NoSuchKey'));
      await expect(service.pullGarden(accountId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getGardenStatus', () => {
    it('should return garden meta when it exists', async () => {
      const meta = { syncedAt: '2026-03-11T00:00:00Z', size: 1024 };
      storeService.download.mockResolvedValue({
        data: Buffer.from(JSON.stringify(meta)),
        metadata: {},
      });

      const result = await service.getGardenStatus(accountId);
      expect(result).toEqual(meta);
    });

    it('should return null when no garden meta exists', async () => {
      storeService.download.mockRejectedValue(new Error('NoSuchKey'));
      const result = await service.getGardenStatus(accountId);
      expect(result).toBeNull();
    });
  });

  describe('pushCrux', () => {
    it('should upload crux ZIP and update index', async () => {
      const data = Buffer.from('crux-zip-data');
      // First download for index returns empty (new index)
      storeService.download.mockRejectedValue(new Error('NoSuchKey'));

      const result = await service.pushCrux(accountId, 'crux-1', data, {
        slug: 'my-crux',
        title: 'My Crux',
      });

      // Upload crux ZIP + save index = 2 uploads
      expect(storeService.upload).toHaveBeenCalledTimes(2);
      expect(storeService.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          path: `sync/${accountId}/cruxes/crux-1.crux`,
          data,
          contentType: 'application/zip',
        }),
      );
      expect(result.cruxId).toBe('crux-1');
      expect(result.slug).toBe('my-crux');
      expect(result.title).toBe('My Crux');
      expect(result.size).toBe(data.length);
    });

    it('should update existing entry in index', async () => {
      const existingIndex = [
        {
          cruxId: 'crux-1',
          slug: 'old-slug',
          title: 'Old Title',
          updatedAt: '2026-01-01',
          size: 100,
        },
      ];
      storeService.download.mockResolvedValue({
        data: Buffer.from(JSON.stringify(existingIndex)),
        metadata: {},
      });

      const data = Buffer.from('updated-crux');
      await service.pushCrux(accountId, 'crux-1', data, {
        slug: 'new-slug',
        title: 'New Title',
      });

      // Check the saved index has updated entry, not a duplicate
      const savedIndex = JSON.parse(
        storeService.upload.mock.calls
          .find((c) => c[0].path.includes('_index.json'))[0]
          .data.toString(),
      );
      expect(savedIndex).toHaveLength(1);
      expect(savedIndex[0].slug).toBe('new-slug');
      expect(savedIndex[0].title).toBe('New Title');
    });
  });

  describe('pullCrux', () => {
    it('should download crux ZIP from S3', async () => {
      const cruxData = Buffer.from('crux-zip');
      storeService.download.mockResolvedValue({
        data: cruxData,
        metadata: {},
      });

      const result = await service.pullCrux(accountId, 'crux-1');
      expect(result).toEqual(cruxData);
      expect(storeService.download).toHaveBeenCalledWith(
        expect.objectContaining({
          path: `sync/${accountId}/cruxes/crux-1.crux`,
        }),
      );
    });

    it('should throw NotFoundException when crux not found', async () => {
      storeService.download.mockRejectedValue(new Error('NoSuchKey'));
      await expect(service.pullCrux(accountId, 'crux-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listCruxes', () => {
    it('should return index entries', async () => {
      const index = [
        {
          cruxId: 'crux-1',
          slug: 'my-crux',
          title: 'My Crux',
          updatedAt: '2026-03-11',
          size: 500,
        },
      ];
      storeService.download.mockResolvedValue({
        data: Buffer.from(JSON.stringify(index)),
        metadata: {},
      });

      const result = await service.listCruxes(accountId);
      expect(result).toEqual(index);
    });

    it('should return empty array when no index exists', async () => {
      storeService.download.mockRejectedValue(new Error('NoSuchKey'));
      const result = await service.listCruxes(accountId);
      expect(result).toEqual([]);
    });
  });

  describe('deleteCrux', () => {
    it('should delete crux ZIP and update index', async () => {
      const index = [
        {
          cruxId: 'crux-1',
          slug: 'my-crux',
          title: 'My Crux',
          updatedAt: '2026-03-11',
          size: 500,
        },
        {
          cruxId: 'crux-2',
          slug: 'other',
          title: 'Other',
          updatedAt: '2026-03-11',
          size: 300,
        },
      ];
      storeService.download.mockResolvedValue({
        data: Buffer.from(JSON.stringify(index)),
        metadata: {},
      });

      await service.deleteCrux(accountId, 'crux-1');

      expect(storeService.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          path: `sync/${accountId}/cruxes/crux-1.crux`,
        }),
      );

      const savedIndex = JSON.parse(
        storeService.upload.mock.calls
          .find((c) => c[0].path.includes('_index.json'))[0]
          .data.toString(),
      );
      expect(savedIndex).toHaveLength(1);
      expect(savedIndex[0].cruxId).toBe('crux-2');
    });
  });
});
