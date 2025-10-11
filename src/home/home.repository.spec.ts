import { Test, TestingModule } from '@nestjs/testing';
import { HomeRepository } from './home.repository';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';

describe('HomeRepository', () => {
  let repository: HomeRepository;
  let dbService: jest.Mocked<DbService>;
  let mockQueryBuilder: any;

  const mockHome = {
    id: 'home-id',
    key: 'home-key',
    name: 'Test Home',
    description: 'A test home',
    primary: true,
    type: 'personal',
    kind: 'garden',
    meta: { color: 'blue', icon: 'tree' },
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
        HomeRepository,
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    repository = module.get<HomeRepository>(HomeRepository);
    dbService = module.get(DbService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findBy', () => {
    it('should return home when found', async () => {
      mockQueryBuilder.first.mockResolvedValue(mockHome);

      const result = await repository.findBy('key', 'home-key');

      expect(result.data).toEqual(mockHome);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('key', 'home-key');
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.first.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findBy('key', 'home-key');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findAllQuery', () => {
    it('should build query for all homes', () => {
      const result = repository.findAllQuery();

      expect(dbService.query).toHaveBeenCalled();
      expect(mockQueryBuilder.whereNull).toHaveBeenCalledWith('deleted');
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('created', 'desc');
      expect(result).toBe(mockQueryBuilder);
    });
  });

  describe('create', () => {
    it('should create home successfully', async () => {
      const createData = {
        id: 'home-id',
        key: 'home-key',
        name: 'Test Home',
        description: 'A test home',
        primary: true,
        type: 'personal',
        kind: 'garden',
      };

      mockQueryBuilder.insert.mockResolvedValue(undefined);
      mockQueryBuilder.first.mockResolvedValue(mockHome);

      const result = await repository.create(createData);

      expect(result.data).toEqual(mockHome);
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
        name: 'Home',
        type: 'personal',
        kind: 'garden',
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('update', () => {
    it('should update home successfully', async () => {
      const updateData = { name: 'Updated Home' };
      const updatedHome = { ...mockHome, name: 'Updated Home' };

      mockQueryBuilder.update.mockResolvedValue(1);
      mockQueryBuilder.first.mockResolvedValue(updatedHome);

      const result = await repository.update('home-id', updateData);

      expect(result.data).toEqual(updatedHome);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Update failed'));

      const result = await repository.update('home-id', { name: 'New' });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('should soft delete home successfully', async () => {
      mockQueryBuilder.update.mockResolvedValue(1);

      const result = await repository.delete('home-id');

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

      const result = await repository.delete('home-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });
});
