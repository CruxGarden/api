import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { DimensionService } from './dimension.service';
import { DimensionRepository } from './dimension.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { DimensionType } from '../common/types/enums';

describe('DimensionService', () => {
  let service: DimensionService;
  let repository: jest.Mocked<DimensionRepository>;

  const mockDimensionRaw = {
    id: 'dimension-id-123',
    key: 'dimension-key-abc',
    source_id: 'crux-source-123',
    target_id: 'crux-target-456',
    type: 'gate' as const,
    weight: 1,
    author_id: 'author-123',
    note: 'test dimension',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  beforeEach(async () => {
    const mockRepository = {
      findBy: jest.fn(),
      findBySourceIdAndTypeQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const mockKeyMaster = {
      generateId: jest.fn().mockReturnValue('generated-id'),
      generateKey: jest.fn().mockReturnValue('generated-key'),
    };

    const mockLoggerService = {
      createChildLogger: jest.fn().mockReturnValue({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DimensionService,
        { provide: DimensionRepository, useValue: mockRepository },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    service = module.get<DimensionService>(DimensionService);
    repository = module.get(DimensionRepository);
  });

  describe('findById', () => {
    it('should return a dimension when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockDimensionRaw,
        error: null,
      });

      const result = await service.findById('dimension-id-123');

      expect(result.id).toBe('dimension-id-123');
      expect(repository.findBy).toHaveBeenCalledWith('id', 'dimension-id-123');
    });

    it('should throw NotFoundException when dimension not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findById('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException on repository error', async () => {
      repository.findBy.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await expect(service.findById('dimension-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByKey', () => {
    it('should return a dimension when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockDimensionRaw,
        error: null,
      });

      const result = await service.findByKey('dimension-key-abc');

      expect(result.key).toBe('dimension-key-abc');
      expect(repository.findBy).toHaveBeenCalledWith(
        'key',
        'dimension-key-abc',
      );
    });

    it('should throw NotFoundException when dimension not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findByKey('invalid-key')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException on repository error', async () => {
      repository.findBy.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await expect(service.findByKey('dimension-key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    const createDto = {
      targetId: 'crux-target-456',
      type: DimensionType.GATE,
      weight: 1,
      note: 'test dimension',
      sourceId: 'crux-source-123',
      authorId: 'author-123',
    };

    it('should create a dimension successfully', async () => {
      repository.create.mockResolvedValue({
        data: mockDimensionRaw,
        error: null,
      });

      const result = await service.create(createDto);

      expect(result.id).toBe('dimension-id-123');
      expect(repository.create).toHaveBeenCalledWith({
        ...createDto,
        id: 'generated-id',
        key: 'generated-key',
      });
    });

    it('should throw InternalServerErrorException on create error', async () => {
      repository.create.mockResolvedValue({
        data: null,
        error: new Error('Create failed'),
      });

      await expect(service.create(createDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('update', () => {
    const updateDto = { type: DimensionType.GARDEN, weight: 2 };

    it('should update a dimension successfully', async () => {
      const updatedDimension = { ...mockDimensionRaw, type: 'garden' as const };
      repository.findBy.mockResolvedValue({
        data: mockDimensionRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedDimension,
        error: null,
      });

      const result = await service.update('dimension-key-abc', updateDto);

      expect(result.type).toBe('garden');
      expect(repository.update).toHaveBeenCalledWith(
        mockDimensionRaw.id,
        updateDto,
      );
    });

    it('should throw InternalServerErrorException on update error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockDimensionRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: null,
        error: new Error('Update failed'),
      });

      await expect(service.update('dimension-key', updateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('delete', () => {
    it('should delete a dimension successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockDimensionRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('dimension-key-abc');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith(mockDimensionRaw.id);
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockDimensionRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('dimension-key')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('asDimension', () => {
    it('should transform raw dimension to entity', () => {
      const result = service.asDimension(mockDimensionRaw);

      expect(result.id).toBe(mockDimensionRaw.id);
      expect(result.sourceId).toBe(mockDimensionRaw.source_id);
      expect(result.targetId).toBe(mockDimensionRaw.target_id);
    });
  });

  describe('asDimensions', () => {
    it('should transform array of raw dimensions to entities', () => {
      const result = service.asDimensions([mockDimensionRaw]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockDimensionRaw.id);
    });
  });
});
