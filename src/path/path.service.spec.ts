import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PathService } from './path.service';
import { PathRepository } from './path.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { TagService } from '../tag/tag.service';
import { CruxService } from '../crux/crux.service';
import { HomeService } from '../home/home.service';
import {
  ResourceType,
  PathType,
  PathVisibility,
  PathKind,
} from '../common/types/enums';

describe('PathService', () => {
  let service: PathService;
  let repository: jest.Mocked<PathRepository>;
  let tagService: jest.Mocked<TagService>;
  let cruxService: jest.Mocked<CruxService>;

  const mockPathRaw = {
    id: 'path-id-123',
    slug: 'test-path',
    title: 'Test Path',
    description: 'A test path',
    type: 'living' as const,
    visibility: 'public' as const,
    kind: 'guide' as const,
    entry: 'crux-entry-id',
    author_id: 'author-123',
    home_id: 'home-id-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const mockMarkerRaw = {
    id: 'marker-id-123',
    path_id: 'path-id-123',
    crux_id: 'crux-id-456',
    order: 1,
    note: 'Test marker',
    author_id: 'author-123',
    home_id: 'home-id-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const mockCrux = {
    id: 'crux-id-456',
    slug: 'test-crux',
  };

  beforeEach(async () => {
    const mockRepository = {
      findBy: jest.fn(),
      findAllQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findMarkersByPathId: jest.fn(),
      createMarker: jest.fn(),
      deleteMarkersByPathId: jest.fn(),
    };

    const mockTagService = {
      getTags: jest.fn(),
      syncTags: jest.fn(),
    };

    const mockCruxService = {
      findById: jest.fn(),
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

    const mockHomeService = {
      primary: jest.fn().mockResolvedValue({
        id: 'home-id-123',
        name: 'Test Home',
        primary: true,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PathService,
        { provide: PathRepository, useValue: mockRepository },
        { provide: TagService, useValue: mockTagService },
        { provide: CruxService, useValue: mockCruxService },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: HomeService, useValue: mockHomeService },
      ],
    }).compile();

    service = module.get<PathService>(PathService);
    repository = module.get(PathRepository);
    tagService = module.get(TagService);
    cruxService = module.get(CruxService);
  });

  describe('findById', () => {
    it('should return a path when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });

      const result = await service.findById('path-id-123');

      expect(result.id).toBe('path-id-123');
      expect(repository.findBy).toHaveBeenCalledWith('id', 'path-id-123');
    });

    it('should throw NotFoundException when path not found', async () => {
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

      await expect(service.findById('path-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    const createDto = {
      slug: 'test-path',
      title: 'Test Path',
      type: PathType.LIVING,
      visibility: PathVisibility.PUBLIC,
      kind: PathKind.GUIDE,
      entry: 'crux-entry-id',
      authorId: 'author-123',
    } as any;

    it('should create a path successfully', async () => {
      repository.create.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });

      const result = await service.create(createDto);

      expect(result.id).toBe('path-id-123');
      expect(repository.create).toHaveBeenCalledWith({
        ...createDto,
        id: 'generated-id',
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

    it('should update a path successfully', async () => {
      const updatedPath = { ...mockPathRaw, title: 'Updated Title' };
      repository.findBy.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedPath,
        error: null,
      });

      const result = await service.update('path-id-123', updateDto);

      expect(result.title).toBe('Updated Title');
      expect(repository.update).toHaveBeenCalledWith(mockPathRaw.id, updateDto);
    });

    it('should throw InternalServerErrorException on update error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: null,
        error: new Error('Update failed'),
      });

      await expect(service.update('path-id-123', updateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('delete', () => {
    it('should delete a path successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('path-id-123');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith(mockPathRaw.id);
    });

    it('should throw NotFoundException when path not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.delete('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('path-id-123')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getMarkers', () => {
    it('should return markers for a path', async () => {
      repository.findBy.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });
      repository.findMarkersByPathId.mockResolvedValue({
        data: [mockMarkerRaw],
        error: null,
      });

      const result = await service.getMarkers('path-id-123');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('marker-id-123');
      expect(repository.findMarkersByPathId).toHaveBeenCalledWith(
        'path-id-123',
      );
    });

    it('should throw InternalServerErrorException on error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });
      repository.findMarkersByPathId.mockResolvedValue({
        data: null,
        error: new Error('Fetch error'),
      });

      await expect(service.getMarkers('path-id-123')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('syncMarkers', () => {
    const markerInputs = [
      { cruxId: 'crux-id-456', order: 1, note: 'Test marker' },
    ];

    it('should sync markers successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });
      repository.deleteMarkersByPathId.mockResolvedValue({
        data: null,
        error: null,
      });
      cruxService.findById.mockResolvedValue(mockCrux as any);
      repository.createMarker.mockResolvedValue({
        data: mockMarkerRaw,
        error: null,
      });

      const result = await service.syncMarkers(
        'path-id-123',
        markerInputs,
        'author-123',
      );

      expect(result).toHaveLength(1);
      expect(repository.deleteMarkersByPathId).toHaveBeenCalledWith(
        'path-id-123',
      );
      expect(repository.createMarker).toHaveBeenCalled();
    });

    it('should throw NotFoundException when crux not found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });
      repository.deleteMarkersByPathId.mockResolvedValue({
        data: null,
        error: null,
      });
      cruxService.findById.mockResolvedValue(null);

      await expect(
        service.syncMarkers('path-id-123', markerInputs, 'author-123'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });
      repository.deleteMarkersByPathId.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(
        service.syncMarkers('path-id-123', markerInputs, 'author-123'),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw InternalServerErrorException on create error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockPathRaw,
        error: null,
      });
      repository.deleteMarkersByPathId.mockResolvedValue({
        data: null,
        error: null,
      });
      cruxService.findById.mockResolvedValue(mockCrux as any);
      repository.createMarker.mockResolvedValue({
        data: null,
        error: new Error('Create failed'),
      });

      await expect(
        service.syncMarkers('path-id-123', markerInputs, 'author-123'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('getTags', () => {
    it('should delegate to tagService.getTags', async () => {
      const mockTags = [{ label: 'test-tag' }] as any;
      tagService.getTags.mockResolvedValue(mockTags);

      const result = await service.getTags('path-id-123', 'filter');

      expect(result).toEqual(mockTags);
      expect(tagService.getTags).toHaveBeenCalledWith(
        ResourceType.PATH,
        'path-id-123',
        'filter',
      );
    });
  });

  describe('syncTags', () => {
    it('should delegate to tagService.syncTags', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      tagService.syncTags.mockResolvedValue(mockTags);

      const result = await service.syncTags(
        'path-id-123',
        ['tag1', 'tag2'],
        'author-123',
      );

      expect(result).toEqual(mockTags);
      expect(tagService.syncTags).toHaveBeenCalledWith(
        ResourceType.PATH,
        'path-id-123',
        ['tag1', 'tag2'],
        'author-123',
      );
    });
  });

  describe('asPath', () => {
    it('should transform raw path to entity', () => {
      const result = service.asPath(mockPathRaw);

      expect(result.id).toBe(mockPathRaw.id);
      expect(result.authorId).toBe(mockPathRaw.author_id);
    });
  });

  describe('asPaths', () => {
    it('should transform array of raw paths to entities', () => {
      const result = service.asPaths([mockPathRaw]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockPathRaw.id);
    });
  });

  describe('asMarker', () => {
    it('should transform raw marker to entity', () => {
      const result = service.asMarker(mockMarkerRaw);

      expect(result.id).toBe(mockMarkerRaw.id);
      expect(result.pathId).toBe(mockMarkerRaw.path_id);
      expect(result.cruxId).toBe(mockMarkerRaw.crux_id);
    });
  });

  describe('asMarkers', () => {
    it('should transform array of raw markers to entities', () => {
      const result = service.asMarkers([mockMarkerRaw]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockMarkerRaw.id);
    });
  });
});
