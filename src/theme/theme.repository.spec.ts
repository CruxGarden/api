import { Test, TestingModule } from '@nestjs/testing';
import { ThemeRepository } from './theme.repository';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';

describe('ThemeRepository', () => {
  let repository: ThemeRepository;
  let dbService: jest.Mocked<DbService>;
  let mockQueryBuilder: any;

  const mockTheme = {
    id: 'theme-id',
    key: 'theme-key',
    author_id: 'author-123',
    title: 'Test Theme',
    description: 'A test theme',
    primary_color: '#000000',
    secondary_color: '#111111',
    tertiary_color: '#222222',
    quaternary_color: '#333333',
    border_radius: '4px',
    background_color: '#ffffff',
    panel_color: '#f5f5f5',
    text_color: '#000000',
    font: 'Arial',
    mode: 'light',
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
        ThemeRepository,
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    repository = module.get<ThemeRepository>(ThemeRepository);
    dbService = module.get(DbService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findBy', () => {
    it('should return theme when found', async () => {
      mockQueryBuilder.first.mockResolvedValue(mockTheme);

      const result = await repository.findBy('key', 'theme-key');

      expect(result.data).toEqual(mockTheme);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('key', 'theme-key');
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.first.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findBy('key', 'theme-key');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findAllQuery', () => {
    it('should build query for all themes', () => {
      const result = repository.findAllQuery();

      expect(dbService.query).toHaveBeenCalled();
      expect(mockQueryBuilder.whereNull).toHaveBeenCalledWith('deleted');
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('created', 'desc');
      expect(result).toBe(mockQueryBuilder);
    });
  });

  describe('create', () => {
    it('should create theme successfully', async () => {
      const createData = {
        id: 'theme-id',
        key: 'theme-key',
        title: 'Test Theme',
        primaryColor: '#000000',
        secondaryColor: '#111111',
        tertiaryColor: '#222222',
        quaternaryColor: '#333333',
        authorId: 'author-123',
      };

      mockQueryBuilder.insert.mockResolvedValue(undefined);
      mockQueryBuilder.first.mockResolvedValue(mockTheme);

      const result = await repository.create(createData);

      expect(result.data).toEqual(mockTheme);
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
        title: 'Theme',
        primaryColor: '#000',
        secondaryColor: '#111',
        tertiaryColor: '#222',
        quaternaryColor: '#333',
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('update', () => {
    it('should update theme successfully', async () => {
      const updateData = { title: 'Updated Theme' };
      const updatedTheme = { ...mockTheme, title: 'Updated Theme' };

      mockQueryBuilder.update.mockResolvedValue(1);
      mockQueryBuilder.first.mockResolvedValue(updatedTheme);

      const result = await repository.update('theme-id', updateData);

      expect(result.data).toEqual(updatedTheme);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Update failed'));

      const result = await repository.update('theme-id', { title: 'New' });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('should soft delete theme successfully', async () => {
      mockQueryBuilder.update.mockResolvedValue(1);

      const result = await repository.delete('theme-id');

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

      const result = await repository.delete('theme-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });
});
