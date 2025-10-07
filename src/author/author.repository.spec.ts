import { Test, TestingModule } from '@nestjs/testing';
import { AuthorRepository } from './author.repository';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';

describe('AuthorRepository', () => {
  let repository: AuthorRepository;
  let mockQueryBuilder: any;

  const mockAuthor = {
    id: 'author-id',
    key: 'author-key',
    account_id: 'account-123',
    username: 'testuser',
    display_name: 'Test User',
    bio: 'A test bio',
    home_id: 'crux-home-123',
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
        AuthorRepository,
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    repository = module.get<AuthorRepository>(AuthorRepository);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findBy', () => {
    it('should return author when found', async () => {
      mockQueryBuilder.first.mockResolvedValue(mockAuthor);

      const result = await repository.findBy('key', 'author-key');

      expect(result.data).toEqual(mockAuthor);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('key', 'author-key');
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.first.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findBy('key', 'author-key');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findAllQuery', () => {
    it('should build query for all authors', () => {
      const result = repository.findAllQuery();

      expect(mockQueryBuilder.whereNull).toHaveBeenCalledWith('deleted');
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('created', 'desc');
      expect(result).toBe(mockQueryBuilder);
    });
  });

  describe('create', () => {
    it('should create author successfully', async () => {
      const createData = {
        id: 'author-id',
        key: 'author-key',
        username: 'testuser',
        displayName: 'Test User',
        accountId: 'account-123',
      };

      mockQueryBuilder.insert.mockResolvedValue(undefined);
      mockQueryBuilder.first.mockResolvedValue(mockAuthor);

      const result = await repository.create(createData);

      expect(result.data).toEqual(mockAuthor);
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
        username: 'user',
        displayName: 'User',
        accountId: 'account',
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('update', () => {
    it('should update author successfully', async () => {
      const updateData = { displayName: 'Updated Name' };
      const updatedAuthor = { ...mockAuthor, display_name: 'Updated Name' };

      mockQueryBuilder.update.mockResolvedValue(1);
      mockQueryBuilder.first.mockResolvedValue(updatedAuthor);

      const result = await repository.update('author-id', updateData);

      expect(result.data).toEqual(updatedAuthor);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Update failed'));

      const result = await repository.update('author-id', {
        displayName: 'New',
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('should soft delete author successfully', async () => {
      mockQueryBuilder.update.mockResolvedValue(1);

      const result = await repository.delete('author-id');

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

      const result = await repository.delete('author-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });
});
