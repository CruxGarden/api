import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ThemeController } from './theme.controller';
import { ThemeService } from './theme.service';
import { AuthorService } from '../author/author.service';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { HomeService } from '../home/home.service';
import { AuthRequest } from '../common/types/interfaces';
import { AccountRole } from '../common/types/enums';

describe('ThemeController', () => {
  let controller: ThemeController;
  let service: jest.Mocked<ThemeService>;
  let authorService: jest.Mocked<AuthorService>;
  let dbService: jest.Mocked<DbService>;

  const mockTheme = {
    id: 'theme-id',
    authorId: 'author-123',
    homeId: 'home-id-123',
    title: 'Test Theme',
    description: 'A test theme',
    type: 'nature',
    kind: 'light',
    system: false,
    meta: {
      palette: { light: { primary: '#4dd9b8' } },
    },
    created: new Date(),
    updated: new Date(),
    deleted: null,
    toJSON: jest.fn().mockReturnThis(),
  };

  const mockAuthor = {
    id: 'author-123',
    accountId: 'account-123',
    name: 'Test Author',
  };

  const mockRequest: AuthRequest = {
    account: {
      id: 'account-123',
      email: 'test@example.com',
      role: AccountRole.AUTHOR,
    },
  } as any;

  const mockResponse = {
    setHeader: jest.fn(),
  } as any;

  beforeEach(async () => {
    const mockService = {
      findById: jest.fn(),
      findAllQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      getTags: jest.fn(),
      syncTags: jest.fn(),
    };

    const mockAuthorService = {
      findByAccountId: jest.fn(),
    };

    const mockDbService = {
      paginate: jest.fn(),
    };

    const mockHomeService = {
      primary: jest.fn().mockResolvedValue({
        id: 'home-id-123',
        name: 'Test Home',
        primary: true,
      }),
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
      controllers: [ThemeController],
      providers: [
        { provide: ThemeService, useValue: mockService },
        { provide: AuthorService, useValue: mockAuthorService },
        { provide: DbService, useValue: mockDbService },
        { provide: HomeService, useValue: mockHomeService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    controller = module.get<ThemeController>(ThemeController);
    service = module.get(ThemeService);
    authorService = module.get(AuthorService);
    dbService = module.get(DbService);
  });

  describe('getAll', () => {
    it('should return paginated themes', async () => {
      const query = {} as any;
      service.findAllQuery.mockReturnValue(query);
      dbService.paginate.mockResolvedValue([mockTheme]);

      const result = await controller.getAll(mockRequest, mockResponse);

      expect(result).toEqual([mockTheme]);
      expect(service.findAllQuery).toHaveBeenCalled();
      expect(dbService.paginate).toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('should return a theme by id', async () => {
      service.findById.mockResolvedValue(mockTheme);

      const result = await controller.getById('theme-id');

      expect(result).toEqual(mockTheme);
      expect(service.findById).toHaveBeenCalledWith('theme-id');
    });
  });

  describe('create', () => {
    const createDto = {
      title: 'Test Theme',
      type: 'nature',
      kind: 'light',
      meta: {
        palette: {
          light: { primary: '#4dd9b8' },
        },
      },
    };

    it('should create a theme successfully', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.create.mockResolvedValue(mockTheme);

      const result = await controller.create(createDto, mockRequest);

      expect(result).toEqual(mockTheme);
      expect(service.create).toHaveBeenCalledWith({
        ...createDto,
        authorId: 'author-123',
      });
    });

    it('should throw NotFoundException when author not found', async () => {
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(controller.create(createDto, mockRequest)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    const updateDto = { title: 'Updated Theme' };

    it('should update a theme when author owns it', async () => {
      const updatedTheme = { ...mockTheme, title: 'Updated Theme' };
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findById.mockResolvedValue(mockTheme);
      service.update.mockResolvedValue(updatedTheme);

      const result = await controller.update(
        'theme-id',
        updateDto,
        mockRequest,
      );

      expect(result).toEqual(updatedTheme);
      expect(service.update).toHaveBeenCalledWith('theme-id', updateDto);
    });

    it('should throw ForbiddenException when author does not own theme', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findById.mockResolvedValue(mockTheme);

      await expect(
        controller.update('theme-id', updateDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when theme or author not found', async () => {
      service.findById.mockResolvedValue(null);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.update('theme-id', updateDto, mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete a theme when author owns it', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findById.mockResolvedValue(mockTheme);
      service.delete.mockResolvedValue(null);

      const result = await controller.delete('theme-id', mockRequest);

      expect(result).toBeNull();
      expect(service.delete).toHaveBeenCalledWith('theme-id');
    });

    it('should throw ForbiddenException when author does not own theme', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findById.mockResolvedValue(mockTheme);

      await expect(controller.delete('theme-id', mockRequest)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw NotFoundException when theme or author not found', async () => {
      service.findById.mockResolvedValue(null);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(controller.delete('theme-id', mockRequest)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getTags', () => {
    it('should return tags for a theme', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      service.getTags.mockResolvedValue(mockTags);

      const result = await controller.getTags('theme-id', 'filter');

      expect(result).toEqual(mockTags);
      expect(service.getTags).toHaveBeenCalledWith('theme-id', 'filter');
    });
  });

  describe('syncTags', () => {
    it('should sync tags when author owns theme', async () => {
      const syncDto = { labels: ['tag1', 'tag2'] };
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findById.mockResolvedValue(mockTheme);
      service.syncTags.mockResolvedValue(mockTags);

      const result = await controller.syncTags(
        'theme-id',
        syncDto,
        mockRequest,
      );

      expect(result).toEqual(mockTags);
      expect(service.syncTags).toHaveBeenCalledWith(
        'theme-id',
        ['tag1', 'tag2'],
        'author-123',
      );
    });

    it('should throw ForbiddenException when author does not own theme', async () => {
      const syncDto = { labels: ['tag1'] };
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findById.mockResolvedValue(mockTheme);

      await expect(
        controller.syncTags('theme-id', syncDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('canManageTheme', () => {
    it('should not throw when author owns theme', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findById.mockResolvedValue(mockTheme);

      await expect(
        controller.canManageTheme('theme-id', mockRequest),
      ).resolves.not.toThrow();
    });

    it('should throw ForbiddenException when author does not own theme', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findById.mockResolvedValue(mockTheme);

      await expect(
        controller.canManageTheme('theme-id', mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when theme or author not found', async () => {
      service.findById.mockResolvedValue(null);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.canManageTheme('theme-id', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
