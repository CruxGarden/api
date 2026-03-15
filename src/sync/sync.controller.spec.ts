import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { LoggerService } from '../common/services/logger.service';

describe('SyncController', () => {
  let controller: SyncController;
  let syncService: jest.Mocked<SyncService>;

  const mockReq = {
    account: { id: 'account-123', email: 'test@test.com', role: 'user' },
  } as any;

  const mockRes = {
    set: jest.fn(),
    send: jest.fn(),
  } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SyncController],
      providers: [
        {
          provide: SyncService,
          useValue: {
            pushGarden: jest.fn(),
            pullGarden: jest.fn(),
            getGardenStatus: jest.fn(),
            pushCrux: jest.fn(),
            pullCrux: jest.fn(),
            listCruxes: jest.fn(),
            deleteCrux: jest.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            createChildLogger: () => ({ debug: jest.fn(), warn: jest.fn() }),
          },
        },
      ],
    }).compile();

    controller = module.get<SyncController>(SyncController);
    syncService = module.get(SyncService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('pushGarden', () => {
    it('should upload garden ZIP via service', async () => {
      const meta = { syncedAt: '2026-03-11T00:00:00Z', size: 1024 };
      syncService.pushGarden.mockResolvedValue(meta);
      const file = { buffer: Buffer.from('zip-data') } as Express.Multer.File;

      const result = await controller.pushGarden(file, mockReq);

      expect(syncService.pushGarden).toHaveBeenCalledWith(
        'account-123',
        file.buffer,
      );
      expect(result).toEqual(meta);
    });

    it('should throw when no file uploaded', async () => {
      await expect(
        controller.pushGarden(undefined as any, mockReq),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('pullGarden', () => {
    it('should stream garden ZIP as response', async () => {
      const data = Buffer.from('garden-zip');
      syncService.pullGarden.mockResolvedValue(data);

      await controller.pullGarden(mockReq, mockRes);

      expect(mockRes.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Type': 'application/zip',
        }),
      );
      expect(mockRes.send).toHaveBeenCalledWith(data);
    });
  });

  describe('getGardenStatus', () => {
    it('should return garden status', async () => {
      const status = { syncedAt: '2026-03-11T00:00:00Z', size: 1024 };
      syncService.getGardenStatus.mockResolvedValue(status);

      const result = await controller.getGardenStatus(mockReq);
      expect(result).toEqual(status);
    });

    it('should throw NotFoundException when no garden exists', async () => {
      syncService.getGardenStatus.mockResolvedValue(null);
      await expect(controller.getGardenStatus(mockReq)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('pushCrux', () => {
    it('should upload crux ZIP via service', async () => {
      const entry = {
        cruxId: 'crux-1',
        slug: 'my-crux',
        title: 'My Crux',
        updatedAt: '2026-03-11',
        size: 500,
      };
      syncService.pushCrux.mockResolvedValue(entry);
      const file = { buffer: Buffer.from('crux-data') } as Express.Multer.File;

      const result = await controller.pushCrux(
        'crux-1',
        file,
        { slug: 'my-crux', title: 'My Crux' },
        mockReq,
      );

      expect(syncService.pushCrux).toHaveBeenCalledWith(
        'account-123',
        'crux-1',
        file.buffer,
        { slug: 'my-crux', title: 'My Crux' },
      );
      expect(result).toEqual(entry);
    });

    it('should throw when no file uploaded', async () => {
      await expect(
        controller.pushCrux('crux-1', undefined as any, {}, mockReq),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('listCruxes', () => {
    it('should return list of synced cruxes', async () => {
      const list = [
        {
          cruxId: 'crux-1',
          slug: 'my-crux',
          title: 'My Crux',
          updatedAt: '2026-03-11',
          size: 500,
        },
      ];
      syncService.listCruxes.mockResolvedValue(list);

      const result = await controller.listCruxes(mockReq);
      expect(result).toEqual(list);
    });
  });

  describe('pullCrux', () => {
    it('should stream crux ZIP as response', async () => {
      const data = Buffer.from('crux-zip');
      syncService.pullCrux.mockResolvedValue(data);

      await controller.pullCrux('crux-1', mockReq, mockRes);

      expect(mockRes.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="crux-1.crux"',
        }),
      );
      expect(mockRes.send).toHaveBeenCalledWith(data);
    });
  });

  describe('deleteCrux', () => {
    it('should delete crux via service', async () => {
      syncService.deleteCrux.mockResolvedValue();

      await controller.deleteCrux('crux-1', mockReq);

      expect(syncService.deleteCrux).toHaveBeenCalledWith(
        'account-123',
        'crux-1',
      );
    });
  });
});
