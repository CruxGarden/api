import { Test, TestingModule } from '@nestjs/testing';
import { CruxRepository } from './crux.repository';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';

describe('CruxRepository', () => {
  let repository: CruxRepository;
  let mockQueryBuilder: any;

  const mockCrux = {
    id: 'crux-id',
    key: 'crux-key',
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
        CruxRepository,
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    repository = module.get<CruxRepository>(CruxRepository);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findBy', () => {
    it('should return crux when found', async () => {
      mockQueryBuilder.first.mockResolvedValue(mockCrux);

      const result = await repository.findBy('key', 'crux-key');

      expect(result.data).toEqual(mockCrux);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('key', 'crux-key');
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.first.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findBy('key', 'crux-key');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findAllQuery', () => {
    it('should build query for all cruxes', () => {
      const result = repository.findAllQuery();

      expect(mockQueryBuilder.whereNull).toHaveBeenCalledWith('deleted');
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('created', 'desc');
      expect(result).toBe(mockQueryBuilder);
    });
  });

  describe('create', () => {
    it('should create crux successfully', async () => {
      const createData = {
        id: 'crux-id',
        key: 'crux-key',
        slug: 'test-crux',
        title: 'Test Crux',
        data: '{}',
        type: 'note',
        authorId: 'author-123',
      };

      mockQueryBuilder.insert.mockResolvedValue(undefined);
      mockQueryBuilder.first.mockResolvedValue(mockCrux);

      const result = await repository.create(createData);

      expect(result.data).toEqual(mockCrux);
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
        data: '{}',
        type: 'note',
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('update', () => {
    it('should update crux successfully', async () => {
      const updateData = { title: 'Updated Title' };
      const updatedCrux = { ...mockCrux, title: 'Updated Title' };

      mockQueryBuilder.update.mockResolvedValue(1);
      mockQueryBuilder.first.mockResolvedValue(updatedCrux);

      const result = await repository.update('crux-id', updateData);

      expect(result.data).toEqual(updatedCrux);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Update failed'));

      const result = await repository.update('crux-id', { title: 'New' });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('should soft delete crux successfully', async () => {
      mockQueryBuilder.update.mockResolvedValue(1);

      const result = await repository.delete('crux-id');

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

      const result = await repository.delete('crux-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });
});
