import { Test, TestingModule } from '@nestjs/testing';
import { DimensionRepository } from './dimension.repository';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { DimensionType } from '../common/types/enums';

describe('DimensionRepository', () => {
  let repository: DimensionRepository;
  let dbService: jest.Mocked<DbService>;
  let mockQueryBuilder: any;

  const mockDimension = {
    id: 'dimension-id',
    key: 'dimension-key',
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
    // Reset query builder before each test
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
        DimensionRepository,
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    repository = module.get<DimensionRepository>(DimensionRepository);
    dbService = module.get(DbService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findBy', () => {
    it('should return dimension when found', async () => {
      mockQueryBuilder.first.mockResolvedValue(mockDimension);

      const result = await repository.findBy('key', 'dimension-key');

      expect(result.data).toEqual(mockDimension);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'key',
        'dimension-key',
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.first.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findBy('key', 'dimension-key');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findBySourceIdAndTypeQuery', () => {
    it('should build query with source ID only', () => {
      const result = repository.findBySourceIdAndTypeQuery('crux-source-123');

      expect(dbService.query).toHaveBeenCalled();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'source_id',
        'crux-source-123',
      );
      expect(mockQueryBuilder.whereNull).toHaveBeenCalledWith('deleted');
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('created', 'desc');
      expect(result).toBe(mockQueryBuilder);
    });

    it('should build query with source ID and type', () => {
      const result = repository.findBySourceIdAndTypeQuery(
        'crux-source-123',
        DimensionType.GATE,
      );

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'source_id',
        'crux-source-123',
      );
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'type',
        DimensionType.GATE,
      );
      expect(result).toBe(mockQueryBuilder);
    });
  });

  describe('create', () => {
    it('should create dimension successfully', async () => {
      const createData = {
        id: 'dimension-id',
        key: 'dimension-key',
        targetId: 'crux-target-456',
        type: DimensionType.GATE,
        weight: 1,
        note: 'test dimension',
        sourceId: 'crux-source-123',
        authorId: 'author-123',
      };

      mockQueryBuilder.insert.mockResolvedValue(undefined);
      mockQueryBuilder.first.mockResolvedValue(mockDimension);

      const result = await repository.create(createData);

      expect(result.data).toEqual(mockDimension);
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
        targetId: 'target',
        type: DimensionType.GATE,
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('update', () => {
    it('should update dimension successfully', async () => {
      const updateData = { type: DimensionType.GARDEN, weight: 2 };
      const updatedDimension = { ...mockDimension, type: 'garden' as const };

      mockQueryBuilder.update.mockResolvedValue(1);
      mockQueryBuilder.first.mockResolvedValue(updatedDimension);

      const result = await repository.update('dimension-id', updateData);

      expect(result.data).toEqual(updatedDimension);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Update failed'));

      const result = await repository.update('dimension-id', { weight: 2 });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('should soft delete dimension successfully', async () => {
      mockQueryBuilder.update.mockResolvedValue(1);

      const result = await repository.delete('dimension-id');

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

      const result = await repository.delete('dimension-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });
});
