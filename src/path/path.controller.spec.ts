import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PathController } from './path.controller';
import { PathService } from './path.service';
import { AuthorService } from '../author/author.service';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { AuthRequest } from '../common/types/interfaces';
import {
  AccountRole,
  PathType,
  PathVisibility,
  PathKind,
} from '../common/types/enums';

describe('PathController', () => {
  let controller: PathController;
  let service: jest.Mocked<PathService>;
  let authorService: jest.Mocked<AuthorService>;
  let dbService: jest.Mocked<DbService>;

  const mockPath = {
    id: 'path-id',
    key: 'path-key',
    slug: 'test-path',
    title: 'Test Path',
    description: 'A test path',
    type: PathType.LIVING,
    visibility: PathVisibility.PUBLIC,
    kind: PathKind.GUIDE,
    entry: 'crux-entry-id',
    authorId: 'author-123',
    themeId: 'theme-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
    toJSON: jest.fn().mockReturnThis(),
  };

  const mockMarker = {
    id: 'marker-id',
    key: 'marker-key',
    pathId: 'path-id',
    cruxId: 'crux-id',
    order: 1,
    note: 'Test marker',
    authorId: 'author-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const mockAuthor = {
    id: 'author-123',
    accountId: 'account-123',
    username: 'testuser',
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
      findByKey: jest.fn(),
      findAllQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      getMarkers: jest.fn(),
      syncMarkers: jest.fn(),
      getTags: jest.fn(),
      syncTags: jest.fn(),
    };

    const mockAuthorService = {
      findByAccountId: jest.fn(),
    };

    const mockDbService = {
      paginate: jest.fn(),
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
      controllers: [PathController],
      providers: [
        { provide: PathService, useValue: mockService },
        { provide: AuthorService, useValue: mockAuthorService },
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    })
      .overrideGuard(require('../common/guards/auth.guard').AuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get<PathController>(PathController);
    service = module.get(PathService);
    authorService = module.get(AuthorService);
    dbService = module.get(DbService);
  });

  describe('findAll', () => {
    it('should return paginated paths', async () => {
      const query = {} as any;
      service.findAllQuery.mockReturnValue(query);
      dbService.paginate.mockResolvedValue([mockPath]);

      const result = await controller.findAll(mockRequest, mockResponse);

      expect(result).toEqual([mockPath]);
      expect(service.findAllQuery).toHaveBeenCalled();
      expect(dbService.paginate).toHaveBeenCalled();
    });
  });

  describe('getByKey', () => {
    it('should return a path by key', async () => {
      service.findByKey.mockResolvedValue(mockPath as any);

      const result = await controller.getByKey('path-key');

      expect(result).toEqual(mockPath);
      expect(service.findByKey).toHaveBeenCalledWith('path-key');
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
    };

    it('should create a path successfully', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.create.mockResolvedValue(mockPath as any);

      const result = await controller.create(createDto, mockRequest);

      expect(result).toEqual(mockPath);
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
    const updateDto = { title: 'Updated Title' };

    it('should update a path when author owns it', async () => {
      const updatedPath = { ...mockPath, title: 'Updated Title' };
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findByKey.mockResolvedValue(mockPath as any);
      service.update.mockResolvedValue(updatedPath as any);

      const result = await controller.update(
        'path-key',
        updateDto,
        mockRequest,
      );

      expect(result).toEqual(updatedPath);
      expect(service.update).toHaveBeenCalledWith('path-key', updateDto);
    });

    it('should throw ForbiddenException when author does not own path', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findByKey.mockResolvedValue(mockPath as any);

      await expect(
        controller.update('path-key', updateDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when author not found', async () => {
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(
        controller.update('path-key', updateDto, mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete a path when author owns it', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findByKey.mockResolvedValue(mockPath as any);
      service.delete.mockResolvedValue(null);

      const result = await controller.delete('path-key', mockRequest);

      expect(result).toBeNull();
      expect(service.delete).toHaveBeenCalledWith('path-key');
    });

    it('should throw ForbiddenException when author does not own path', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findByKey.mockResolvedValue(mockPath as any);

      await expect(controller.delete('path-key', mockRequest)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('getMarkers', () => {
    it('should return markers for a path', async () => {
      service.getMarkers.mockResolvedValue([mockMarker] as any);

      const result = await controller.getMarkers('path-key');

      expect(result).toEqual([mockMarker]);
      expect(service.getMarkers).toHaveBeenCalledWith('path-key');
    });
  });

  describe('syncMarkers', () => {
    const syncDto = {
      markers: [{ cruxKey: 'crux-key', order: 1, note: 'Test' }],
    };

    it('should sync markers when author owns path', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findByKey.mockResolvedValue(mockPath as any);
      service.syncMarkers.mockResolvedValue([mockMarker] as any);

      const result = await controller.syncMarkers(
        'path-key',
        syncDto,
        mockRequest,
      );

      expect(result).toEqual([mockMarker]);
      expect(service.syncMarkers).toHaveBeenCalledWith(
        'path-key',
        syncDto.markers,
        'author-123',
      );
    });

    it('should throw ForbiddenException when author does not own path', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findByKey.mockResolvedValue(mockPath as any);

      await expect(
        controller.syncMarkers('path-key', syncDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getTags', () => {
    it('should return tags for a path', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      service.getTags.mockResolvedValue(mockTags);

      const result = await controller.getTags('path-key', 'filter');

      expect(result).toEqual(mockTags);
      expect(service.getTags).toHaveBeenCalledWith('path-key', 'filter');
    });
  });

  describe('syncTags', () => {
    const syncDto = { labels: ['tag1', 'tag2'] };

    it('should sync tags when author owns path', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findByKey.mockResolvedValue(mockPath as any);
      service.syncTags.mockResolvedValue(mockTags);

      const result = await controller.syncTags(
        'path-key',
        syncDto,
        mockRequest,
      );

      expect(result).toEqual(mockTags);
      expect(service.syncTags).toHaveBeenCalledWith(
        'path-key',
        ['tag1', 'tag2'],
        'author-123',
      );
    });

    it('should throw ForbiddenException when author does not own path', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findByKey.mockResolvedValue(mockPath as any);

      await expect(
        controller.syncTags('path-key', syncDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('canManagePath', () => {
    it('should return true when author owns path', async () => {
      service.findByKey.mockResolvedValue(mockPath as any);

      const result = await controller.canManagePath(
        'path-key',
        mockAuthor as any,
      );

      expect(result).toBe(true);
    });

    it('should throw ForbiddenException when author does not own path', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      service.findByKey.mockResolvedValue(mockPath as any);

      await expect(
        controller.canManagePath('path-key', otherAuthor as any),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getAuthor', () => {
    it('should return author for account', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      const result = await controller.getAuthor(mockRequest);

      expect(result).toEqual(mockAuthor);
      expect(authorService.findByAccountId).toHaveBeenCalledWith('account-123');
    });

    it('should throw NotFoundException when author not found', async () => {
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(controller.getAuthor(mockRequest)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getPathByKey', () => {
    it('should return path when found', async () => {
      service.findByKey.mockResolvedValue(mockPath as any);

      const result = await controller.getPathByKey('path-key');

      expect(result).toEqual(mockPath);
    });

    it('should throw NotFoundException when path not found', async () => {
      service.findByKey.mockResolvedValue(null);

      await expect(controller.getPathByKey('invalid-key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
