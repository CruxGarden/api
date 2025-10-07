import { Test, TestingModule } from '@nestjs/testing';
import { TagRepository } from './tag.repository';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { ResourceType } from '../common/types/enums';

describe('TagRepository', () => {
  let repository: TagRepository;
  let dbService: jest.Mocked<DbService>;
  let mockQueryBuilder: any;

  const mockTag = {
    id: 'tag-id',
    key: 'tag-key',
    resource_type: 'crux',
    resource_id: 'crux-123',
    label: 'test-tag',
    author_id: 'author-123',
    system: false,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  beforeEach(async () => {
    // Reset query builder before each test
    mockQueryBuilder = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      count: jest.fn().mockReturnThis(),
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
        TagRepository,
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    repository = module.get<TagRepository>(TagRepository);
    dbService = module.get(DbService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findBy', () => {
    it('should return tag when found', async () => {
      mockQueryBuilder.first.mockResolvedValue(mockTag);

      const result = await repository.findBy('key', 'tag-key');

      expect(result.data).toEqual(mockTag);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('key', 'tag-key');
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.first.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findBy('key', 'tag-key');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findByResource', () => {
    it('should return tags for resource', async () => {
      mockQueryBuilder.orderBy.mockResolvedValue([mockTag]);

      const result = await repository.findByResource(
        ResourceType.CRUX,
        'crux-123',
      );

      expect(result.data).toEqual([mockTag]);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'resource_type',
        ResourceType.CRUX,
      );
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'resource_id',
        'crux-123',
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.orderBy.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findByResource(
        ResourceType.CRUX,
        'crux-123',
      );

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('update', () => {
    it('should update tag successfully', async () => {
      const updateData = { label: 'updated-tag' };
      const updatedTag = { ...mockTag, label: 'updated-tag' };

      mockQueryBuilder.update.mockResolvedValue(1);
      mockQueryBuilder.first.mockResolvedValue(updatedTag);

      const result = await repository.update('tag-id', updateData);

      expect(result.data).toEqual(updatedTag);
      expect(result.error).toBeNull();
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Update failed'));

      const result = await repository.update('tag-id', { label: 'new' });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('should soft delete tag successfully', async () => {
      mockQueryBuilder.update.mockResolvedValue(1);

      const result = await repository.delete('tag-id');

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

      const result = await repository.delete('tag-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('deleteByResource', () => {
    it('should soft delete all tags for a resource', async () => {
      mockQueryBuilder.update.mockResolvedValue(3);

      const result = await repository.deleteByResource(
        ResourceType.CRUX,
        'crux-123',
      );

      expect(result.data).toBeNull();
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'resource_type',
        ResourceType.CRUX,
      );
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'resource_id',
        'crux-123',
      );
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          deleted: expect.any(Date),
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Delete failed'));

      const result = await repository.deleteByResource(
        ResourceType.CRUX,
        'crux-123',
      );

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('createMany', () => {
    it('should create multiple tags', async () => {
      const tags = [
        { id: 'id-1', key: 'key-1', label: 'tag1' },
        { id: 'id-2', key: 'key-2', label: 'tag2' },
      ];

      mockQueryBuilder.insert.mockResolvedValue(undefined);
      mockQueryBuilder.whereIn.mockResolvedValue([mockTag, mockTag]);

      const result = await repository.createMany(tags);

      expect(result.data).toHaveLength(2);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.insert).toHaveBeenCalled();
      expect(mockQueryBuilder.whereIn).toHaveBeenCalledWith('id', [
        'id-1',
        'id-2',
      ]);
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.insert.mockRejectedValue(new Error('Insert failed'));

      const result = await repository.createMany([{ id: 'id', label: 'tag' }]);

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findAllQuery', () => {
    it('should build query with resource type filter', () => {
      repository.findAllQuery(ResourceType.CRUX);

      expect(dbService.query).toHaveBeenCalled();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'resource_type',
        ResourceType.CRUX,
      );
    });

    it('should build query with search filter', () => {
      repository.findAllQuery(undefined, 'test');

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'label',
        'ilike',
        '%test%',
      );
    });

    it('should build query with label filter', () => {
      repository.findAllQuery(undefined, undefined, 'count', 'javascript');

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'label',
        'javascript',
      );
    });

    it('should build query with alpha sort', () => {
      repository.findAllQuery(undefined, undefined, 'alpha');

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('label', 'asc');
    });

    it('should build query with count sort (default)', () => {
      repository.findAllQuery(undefined, undefined, 'count');

      expect(mockQueryBuilder.groupBy).toHaveBeenCalledWith('label');
      expect(mockQueryBuilder.count).toHaveBeenCalledWith('* as count');
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('count', 'desc');
    });
  });
});
