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
import { ArtifactService } from '../artifact/artifact.service';
import { StoreService } from '../common/services/store.service';
import { DimensionType, ResourceType } from '../common/types/enums';

describe('CruxService', () => {
  let service: CruxService;
  let repository: jest.Mocked<CruxRepository>;
  let dimensionService: jest.Mocked<DimensionService>;
  let tagService: jest.Mocked<TagService>;

  const mockCruxRaw = {
    id: 'crux-id-123',
    slug: 'test-crux',
    title: 'Test Crux',
    description: 'A test crux',
    data: '{}',
    type: 'note',
    status: 'living' as const,
    visibility: 'public' as const,
    author_id: 'author-123',
    home_id: 'home-id-123',
    meta: null,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  beforeEach(async () => {
    const mockRepository = {
      findBy: jest.fn(),
      findByIdIncludingDeleted: jest.fn().mockResolvedValue({ data: null, error: null }),
      findByAuthorAndSlug: jest.fn(),
      findAllByAuthorQuery: jest.fn(),
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

    const mockArtifactService = {
      findByResource: jest.fn(),
      createWithFile: jest.fn(),
      findById: jest.fn(),
      downloadArtifact: jest.fn(),
    };

    const mockKeyMaster = {
      generateId: jest.fn().mockReturnValue('generated-id'),
    };

    const mockLoggerService = {
      createChildLogger: jest.fn().mockReturnValue({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    };

    const mockStoreService = {
      upload: jest.fn(),
      download: jest.fn(),
      delete: jest.fn(),
      invalidateCache: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CruxService,
        { provide: CruxRepository, useValue: mockRepository },
        { provide: DimensionService, useValue: mockDimensionService },
        { provide: TagService, useValue: mockTagService },
        { provide: ArtifactService, useValue: mockArtifactService },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: StoreService, useValue: mockStoreService },
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

  describe('findByAuthorAndSlug', () => {
    it('should return a crux when found', async () => {
      repository.findByAuthorAndSlug.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });

      const result = await service.findByAuthorAndSlug(
        'author-123',
        'test-crux',
      );

      expect(result.slug).toBe('test-crux');
      expect(repository.findByAuthorAndSlug).toHaveBeenCalledWith(
        'author-123',
        'test-crux',
      );
    });

    it('should throw NotFoundException when crux not found', async () => {
      repository.findByAuthorAndSlug.mockResolvedValue({
        data: null,
        error: null,
      });

      await expect(
        service.findByAuthorAndSlug('author-123', 'invalid-slug'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException on repository error', async () => {
      repository.findByAuthorAndSlug.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await expect(
        service.findByAuthorAndSlug('author-123', 'test-crux'),
      ).rejects.toThrow(NotFoundException);
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
      repository.findByAuthorAndSlug.mockResolvedValue({
        data: null,
        error: null,
      });
      repository.create.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });

      const result = await service.create(createDto);

      expect(result.id).toBe('crux-id-123');
      expect(repository.create).toHaveBeenCalledWith({
        ...createDto,
        id: 'generated-id',
      });
    });

    it('should throw InternalServerErrorException on create error', async () => {
      repository.findByAuthorAndSlug.mockResolvedValue({
        data: null,
        error: null,
      });
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

      const result = await service.update('crux-id-123', updateDto);

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

      await expect(service.update('crux-id-123', updateDto)).rejects.toThrow(
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

      const result = await service.delete('crux-id-123');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith(mockCruxRaw.id, undefined, false);
    });

    it('should throw NotFoundException when crux not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.delete('invalid-id')).rejects.toThrow(
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

      await expect(service.delete('crux-id-123')).rejects.toThrow(
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
        false,
        true,
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
        'crux-id-123',
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
        service.createDimension('invalid-id', createDimensionDto),
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
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      tagService.getTags.mockResolvedValue(mockTags);

      const result = await service.getTags('crux-id-123', 'filter');

      expect(result).toEqual(mockTags);
      expect(repository.findBy).toHaveBeenCalledWith('id', 'crux-id-123');
      expect(tagService.getTags).toHaveBeenCalledWith(
        ResourceType.CRUX,
        mockCruxRaw.id,
        'filter',
      );
    });
  });

  describe('syncTags', () => {
    it('should delegate to tagService.syncTags', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      tagService.syncTags.mockResolvedValue(mockTags);

      const result = await service.syncTags(
        'crux-id-123',
        ['tag1', 'tag2'],
        'author-123',
      );

      expect(result).toEqual(mockTags);
      expect(repository.findBy).toHaveBeenCalledWith('id', 'crux-id-123');
      expect(tagService.syncTags).toHaveBeenCalledWith(
        ResourceType.CRUX,
        mockCruxRaw.id,
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
