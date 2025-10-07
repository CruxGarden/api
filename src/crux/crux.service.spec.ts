import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { CruxService } from './crux.service';
import { CruxRepository } from './crux.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { DimensionService } from '../dimension/dimension.service';
import { TagService } from '../tag/tag.service';
import { DimensionType, ResourceType } from '../common/types/enums';

describe('CruxService', () => {
  let service: CruxService;
  let repository: jest.Mocked<CruxRepository>;
  let dimensionService: jest.Mocked<DimensionService>;
  let tagService: jest.Mocked<TagService>;

  const mockCruxRaw = {
    id: 'crux-id-123',
    key: 'crux-key-abc',
    slug: 'test-crux',
    title: 'Test Crux',
    description: 'A test crux',
    data: '{}',
    type: 'note',
    theme_id: 'theme-123',
    status: 'living' as const,
    visibility: 'public' as const,
    author_id: 'author-123',
    meta: null,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  beforeEach(async () => {
    const mockRepository = {
      findBy: jest.fn(),
      findAllQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const mockDimensionService = {
      findBySourceIdAndTypeQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const mockTagService = {
      getTags: jest.fn(),
      syncTags: jest.fn(),
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
        CruxService,
        { provide: CruxRepository, useValue: mockRepository },
        { provide: DimensionService, useValue: mockDimensionService },
        { provide: TagService, useValue: mockTagService },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    service = module.get<CruxService>(CruxService);
    repository = module.get(CruxRepository);
    dimensionService = module.get(DimensionService);
    tagService = module.get(TagService);
  });

  describe('findById', () => {
    it('should return a crux when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });

      const result = await service.findById('crux-id-123');

      expect(result.id).toBe('crux-id-123');
      expect(repository.findBy).toHaveBeenCalledWith('id', 'crux-id-123');
    });

    it('should throw NotFoundException when crux not found', async () => {
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

      await expect(service.findById('crux-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByKey', () => {
    it('should return a crux when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });

      const result = await service.findByKey('crux-key-abc');

      expect(result.key).toBe('crux-key-abc');
      expect(repository.findBy).toHaveBeenCalledWith('key', 'crux-key-abc');
    });

    it('should throw NotFoundException when crux not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findByKey('invalid-key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    const createDto = {
      slug: 'test-crux',
      title: 'Test Crux',
      data: '{}',
      type: 'note',
      authorId: 'author-123',
    };

    it('should create a crux successfully', async () => {
      repository.create.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });

      const result = await service.create(createDto);

      expect(result.id).toBe('crux-id-123');
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
    const updateDto = { title: 'Updated Title', description: 'Updated' };

    it('should update a crux successfully', async () => {
      const updatedCrux = { ...mockCruxRaw, title: 'Updated Title' };
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedCrux,
        error: null,
      });

      const result = await service.update('crux-key-abc', updateDto);

      expect(result.title).toBe('Updated Title');
      expect(repository.update).toHaveBeenCalledWith(mockCruxRaw.id, updateDto);
    });

    it('should throw InternalServerErrorException on update error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: null,
        error: new Error('Update failed'),
      });

      await expect(service.update('crux-key', updateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('delete', () => {
    it('should delete a crux successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('crux-key-abc');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith(mockCruxRaw.id);
    });

    it('should throw NotFoundException when crux not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.delete('crux-key')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('crux-key')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getDimensionsQuery', () => {
    it('should delegate to dimensionService', () => {
      const mockQuery = {} as any;
      dimensionService.findBySourceIdAndTypeQuery.mockReturnValue(mockQuery);

      const result = service.getDimensionsQuery('crux-123', DimensionType.GATE);

      expect(result).toBe(mockQuery);
      expect(dimensionService.findBySourceIdAndTypeQuery).toHaveBeenCalledWith(
        'crux-123',
        DimensionType.GATE,
      );
    });
  });

  describe('createDimension', () => {
    const createDimensionDto = {
      targetId: 'target-crux-123',
      type: DimensionType.GATE,
    };

    it('should create a dimension successfully', async () => {
      const mockDimension = { id: 'dim-123' } as any;
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      dimensionService.create.mockResolvedValue(mockDimension);

      const result = await service.createDimension(
        'crux-key-abc',
        createDimensionDto,
      );

      expect(result).toBe(mockDimension);
      expect(dimensionService.create).toHaveBeenCalledWith({
        ...createDimensionDto,
        sourceId: mockCruxRaw.id,
      });
    });

    it('should throw NotFoundException when crux not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(
        service.createDimension('invalid-key', createDimensionDto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateDimension', () => {
    it('should delegate to dimensionService.update', async () => {
      const updateDto = { type: DimensionType.GARDEN };
      const mockDimension = { id: 'dim-123' } as any;
      dimensionService.update.mockResolvedValue(mockDimension);

      const result = await service.updateDimension('dim-123', updateDto);

      expect(result).toBe(mockDimension);
      expect(dimensionService.update).toHaveBeenCalledWith(
        'dim-123',
        updateDto,
      );
    });
  });

  describe('getTags', () => {
    it('should delegate to tagService.getTags', async () => {
      const mockTags = [{ label: 'test-tag' }] as any;
      tagService.getTags.mockResolvedValue(mockTags);

      const result = await service.getTags('crux-key', 'filter');

      expect(result).toEqual(mockTags);
      expect(tagService.getTags).toHaveBeenCalledWith(
        ResourceType.CRUX,
        'crux-key',
        'filter',
      );
    });
  });

  describe('syncTags', () => {
    it('should delegate to tagService.syncTags', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      tagService.syncTags.mockResolvedValue(mockTags);

      const result = await service.syncTags(
        'crux-key',
        ['tag1', 'tag2'],
        'author-123',
      );

      expect(result).toEqual(mockTags);
      expect(tagService.syncTags).toHaveBeenCalledWith(
        ResourceType.CRUX,
        'crux-key',
        ['tag1', 'tag2'],
        'author-123',
      );
    });
  });

  describe('asCrux', () => {
    it('should transform raw crux to entity', () => {
      const result = service.asCrux(mockCruxRaw);

      expect(result.id).toBe(mockCruxRaw.id);
      expect(result.authorId).toBe(mockCruxRaw.author_id);
      expect(result.themeId).toBe(mockCruxRaw.theme_id);
    });
  });

  describe('asCruxes', () => {
    it('should transform array of raw cruxes to entities', () => {
      const result = service.asCruxes([mockCruxRaw]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockCruxRaw.id);
    });
  });
});
