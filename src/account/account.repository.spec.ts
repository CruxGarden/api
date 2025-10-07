import { Test, TestingModule } from '@nestjs/testing';
import { AccountRepository } from './account.repository';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';

describe('AccountRepository', () => {
  let repository: AccountRepository;
  let mockQueryBuilder: any;

  const mockAccount = {
    id: 'account-id',
    key: 'account-key',
    email: 'test@example.com',
    role: 'author' as const,
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
        AccountRepository,
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    repository = module.get<AccountRepository>(AccountRepository);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findById', () => {
    it('should return account when found', async () => {
      mockQueryBuilder.first.mockResolvedValue(mockAccount);

      const result = await repository.findById('account-id');

      expect(result.data).toEqual(mockAccount);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('id', 'account-id');
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.first.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findById('account-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findByEmail', () => {
    it('should return account when found', async () => {
      mockQueryBuilder.first.mockResolvedValue(mockAccount);

      const result = await repository.findByEmail('test@example.com');

      expect(result.data).toEqual(mockAccount);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'email',
        'test@example.com',
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.first.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findByEmail('test@example.com');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('create', () => {
    it('should create account successfully', async () => {
      const createData = {
        id: 'account-id',
        key: 'account-key',
        email: 'test@example.com',
      };

      mockQueryBuilder.insert.mockResolvedValue(undefined);
      mockQueryBuilder.first.mockResolvedValue(mockAccount);

      const result = await repository.create(createData);

      expect(result.data).toEqual(mockAccount);
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
        email: 'test@example.com',
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('update', () => {
    it('should update account successfully', async () => {
      const updateData = { email: 'updated@example.com' };
      const updatedAccount = { ...mockAccount, email: 'updated@example.com' };

      mockQueryBuilder.update.mockResolvedValue(1);
      mockQueryBuilder.first.mockResolvedValue(updatedAccount);

      const result = await repository.update('account-id', updateData);

      expect(result.data).toEqual(updatedAccount);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Update failed'));

      const result = await repository.update('account-id', {
        email: 'new@example.com',
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('should soft delete account successfully', async () => {
      mockQueryBuilder.update.mockResolvedValue(1);

      const result = await repository.delete('account-id');

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

      const result = await repository.delete('account-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });
});
