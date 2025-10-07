import { Test, TestingModule } from '@nestjs/testing';
import { PathRepository } from './path.repository';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { PathType, PathVisibility, PathKind } from '../common/types/enums';

describe('PathRepository', () => {
  let repository: PathRepository;
  let mockQueryBuilder: any;

  const mockPath = {
    id: 'path-id',
    key: 'path-key',
    slug: 'test-path',
    title: 'Test Path',
    description: 'A test path',
    type: 'living' as const,
    visibility: 'public' as const,
    kind: 'guide' as const,
    entry: 'crux-entry-id',
    author_id: 'author-123',
    theme_id: 'theme-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const mockMarker = {
    id: 'marker-id',
    key: 'marker-key',
    path_id: 'path-id',
    crux_id: 'crux-id',
    order: 1,
    note: 'Test marker',
    author_id: 'author-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  beforeEach(async () => {
    mockQueryBuilder = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
    };

    const mockDbService = {
      query: jest.fn().mockReturnValue(mockQueryBuilder),
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
        PathRepository,
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    repository = module.get<PathRepository>(PathRepository);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findBy', () => {
    it('should return path when found', async () => {
      mockQueryBuilder.first.mockResolvedValue(mockPath);

      const result = await repository.findBy('key', 'path-key');

      expect(result.data).toEqual(mockPath);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('key', 'path-key');
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.first.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findBy('key', 'path-key');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findAllQuery', () => {
    it('should build query for all paths', () => {
      const result = repository.findAllQuery();

      expect(mockQueryBuilder.whereNull).toHaveBeenCalledWith('deleted');
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('created', 'desc');
      expect(result).toBe(mockQueryBuilder);
    });
  });

  describe('create', () => {
    it('should create path successfully', async () => {
      const createData = {
        id: 'path-id',
        key: 'path-key',
        slug: 'test-path',
        title: 'Test Path',
        type: PathType.LIVING,
        visibility: PathVisibility.PUBLIC,
        kind: PathKind.GUIDE,
        entry: 'crux-entry-id',
        authorId: 'author-123',
      } as any;

      mockQueryBuilder.insert.mockResolvedValue(undefined);
      mockQueryBuilder.first.mockResolvedValue(mockPath);

      const result = await repository.create(createData);

      expect(result.data).toEqual(mockPath);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          created: expect.any(Date),
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.insert.mockRejectedValue(new Error('Insert failed'));

      const result = await repository.create({
        id: 'id',
        key: 'key',
        slug: 'slug',
        type: PathType.LIVING,
        visibility: PathVisibility.PUBLIC,
        kind: PathKind.GUIDE,
        entry: 'entry',
      } as any);

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('update', () => {
    it('should update path successfully', async () => {
      const updateData = { title: 'Updated Title' };
      const updatedPath = { ...mockPath, title: 'Updated Title' };

      mockQueryBuilder.update.mockResolvedValue(1);
      mockQueryBuilder.first.mockResolvedValue(updatedPath);

      const result = await repository.update('path-id', updateData);

      expect(result.data).toEqual(updatedPath);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Update failed'));

      const result = await repository.update('path-id', { title: 'New' });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('should soft delete path successfully', async () => {
      mockQueryBuilder.update.mockResolvedValue(1);

      const result = await repository.delete('path-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          deleted: expect.any(Date),
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Delete failed'));

      const result = await repository.delete('path-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findMarkersByPathId', () => {
    it('should return markers for a path', async () => {
      // Mock the promise chain - orderBy returns the final promise with the data
      const mockPromise = Promise.resolve([mockMarker]);
      mockQueryBuilder.orderBy.mockReturnValue(mockPromise);

      const result = await repository.findMarkersByPathId('path-id');

      expect(result.data).toEqual([mockMarker]);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('path_id', 'path-id');
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('order', 'asc');
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.orderBy.mockRejectedValue(new Error('Fetch error'));

      const result = await repository.findMarkersByPathId('path-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('createMarker', () => {
    it('should create marker successfully', async () => {
      const createData = {
        id: 'marker-id',
        key: 'marker-key',
        pathId: 'path-id',
        cruxId: 'crux-id',
        order: 1,
        note: 'Test marker',
        authorId: 'author-123',
      };

      mockQueryBuilder.insert.mockResolvedValue(undefined);
      mockQueryBuilder.first.mockResolvedValue(mockMarker);

      const result = await repository.createMarker(createData);

      expect(result.data).toEqual(mockMarker);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          created: expect.any(Date),
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.insert.mockRejectedValue(new Error('Insert failed'));

      const result = await repository.createMarker({
        id: 'id',
        key: 'key',
        pathId: 'path-id',
        cruxId: 'crux-id',
        order: 1,
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('deleteMarkersByPathId', () => {
    it('should soft delete all markers for a path', async () => {
      mockQueryBuilder.update.mockResolvedValue(3);

      const result = await repository.deleteMarkersByPathId('path-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('path_id', 'path-id');
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          deleted: expect.any(Date),
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Delete failed'));

      const result = await repository.deleteMarkersByPathId('path-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });
});
