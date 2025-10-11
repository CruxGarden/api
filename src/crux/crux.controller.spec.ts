import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CruxController } from './crux.controller';
import { CruxService } from './crux.service';
import { AuthorService } from '../author/author.service';
import { DbService } from '../common/services/db.service';
import { HomeService } from '../home/home.service';
import { AuthRequest } from '../common/types/interfaces';
import { AccountRole, DimensionType } from '../common/types/enums';

describe('CruxController', () => {
  let controller: CruxController;
  let service: jest.Mocked<CruxService>;
  let authorService: jest.Mocked<AuthorService>;
  let dbService: jest.Mocked<DbService>;

  const mockCrux = {
    id: 'crux-id',
    key: 'crux-key',
    slug: 'test-crux',
    title: 'Test Crux',
    data: '{}',
    type: 'note',
    authorId: 'author-123',
    homeId: 'home-id-123',
    status: 'living' as const,
    visibility: 'public' as const,
    created: new Date(),
    updated: new Date(),
    deleted: null,
    toJSON: jest.fn().mockReturnThis(),
  };

  const mockAuthor = {
    id: 'author-123',
    accountId: 'account-123',
    username: 'testuser',
  };

  const mockDimension = {
    id: 'dimension-id',
    key: 'dimension-key',
    sourceId: 'crux-id',
    targetId: 'target-id',
    type: 'gate' as const,
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
      getDimensionsQuery: jest.fn(),
      createDimension: jest.fn(),
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
        key: 'home-key',
        name: 'Test Home',
        primary: true,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CruxController],
      providers: [
        { provide: CruxService, useValue: mockService },
        { provide: AuthorService, useValue: mockAuthorService },
        { provide: DbService, useValue: mockDbService },
        { provide: HomeService, useValue: mockHomeService },
      ],
    })
      .overrideGuard(require('../common/guards/auth.guard').AuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get<CruxController>(CruxController);
    service = module.get(CruxService);
    authorService = module.get(AuthorService);
    dbService = module.get(DbService);
  });

  describe('findAll', () => {
    it('should return paginated cruxes', async () => {
      const query = {} as any;
      service.findAllQuery.mockReturnValue(query);
      dbService.paginate.mockResolvedValue([mockCrux]);

      const result = await controller.findAll(mockRequest, mockResponse);

      expect(result).toEqual([mockCrux]);
      expect(service.findAllQuery).toHaveBeenCalled();
      expect(dbService.paginate).toHaveBeenCalled();
    });
  });

  describe('getByKey', () => {
    it('should return a crux by key', async () => {
      service.findByKey.mockResolvedValue(mockCrux);

      const result = await controller.getByKey('crux-key');

      expect(result).toEqual(mockCrux);
      expect(service.findByKey).toHaveBeenCalledWith('crux-key');
    });
  });

  describe('create', () => {
    const createDto = {
      slug: 'test-crux',
      title: 'Test Crux',
      data: '{}',
      type: 'note',
    };

    it('should create a crux successfully', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.create.mockResolvedValue(mockCrux);

      const result = await controller.create(createDto, mockRequest);

      expect(result).toEqual(mockCrux);
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

    it('should update a crux when author owns it', async () => {
      const updatedCrux = { ...mockCrux, title: 'Updated Title' };
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findByKey.mockResolvedValue(mockCrux);
      service.update.mockResolvedValue(updatedCrux);

      const result = await controller.update(
        'crux-key',
        updateDto,
        mockRequest,
      );

      expect(result).toEqual(updatedCrux);
      expect(service.update).toHaveBeenCalledWith('crux-key', updateDto);
    });

    it('should throw ForbiddenException when author does not own crux', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findByKey.mockResolvedValue(mockCrux);

      await expect(
        controller.update('crux-key', updateDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when author not found', async () => {
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(
        controller.update('crux-key', updateDto, mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete a crux when author owns it', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findByKey.mockResolvedValue(mockCrux);
      service.delete.mockResolvedValue(null);

      const result = await controller.delete('crux-key', mockRequest);

      expect(result).toBeNull();
      expect(service.delete).toHaveBeenCalledWith('crux-key');
    });

    it('should throw ForbiddenException when author does not own crux', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findByKey.mockResolvedValue(mockCrux);

      await expect(controller.delete('crux-key', mockRequest)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('getDimensions', () => {
    it('should return paginated dimensions for a crux', async () => {
      const query = {} as any;
      service.findByKey.mockResolvedValue(mockCrux);
      service.getDimensionsQuery.mockReturnValue(query);
      dbService.paginate.mockResolvedValue([mockDimension]);

      const result = await controller.getDimensions(
        mockRequest,
        mockResponse,
        'crux-key',
        DimensionType.GATE,
      );

      expect(result).toEqual([mockDimension]);
      expect(service.getDimensionsQuery).toHaveBeenCalledWith(
        'crux-id',
        DimensionType.GATE,
      );
    });

    it('should throw NotFoundException when crux not found', async () => {
      service.findByKey.mockResolvedValue(null);

      await expect(
        controller.getDimensions(mockRequest, mockResponse, 'invalid-key'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createDimension', () => {
    const createDimensionDto = {
      targetId: 'target-crux-123',
      type: DimensionType.GATE,
    };

    it('should create a dimension when author owns crux', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findByKey.mockResolvedValue(mockCrux);
      service.createDimension.mockResolvedValue(mockDimension as any);

      const result = await controller.createDimension(
        'crux-key',
        createDimensionDto,
        mockRequest,
      );

      expect(result).toEqual(mockDimension);
      expect(service.createDimension).toHaveBeenCalledWith('crux-key', {
        ...createDimensionDto,
        authorId: 'author-123',
      });
    });

    it('should throw ForbiddenException when author does not own crux', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findByKey.mockResolvedValue(mockCrux);

      await expect(
        controller.createDimension('crux-key', createDimensionDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getTags', () => {
    it('should return tags for a crux', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      service.findByKey.mockResolvedValue(mockCrux);
      service.getTags.mockResolvedValue(mockTags);

      const result = await controller.getTags('crux-key', 'filter');

      expect(result).toEqual(mockTags);
      expect(service.getTags).toHaveBeenCalledWith('crux-key', 'filter');
    });

    it('should throw NotFoundException when crux not found', async () => {
      service.findByKey.mockResolvedValue(null);

      await expect(controller.getTags('invalid-key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('syncTags', () => {
    const syncDto = { labels: ['tag1', 'tag2'] };

    it('should sync tags when author owns crux', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findByKey.mockResolvedValue(mockCrux);
      service.syncTags.mockResolvedValue(mockTags);

      const result = await controller.syncTags(
        'crux-key',
        syncDto,
        mockRequest,
      );

      expect(result).toEqual(mockTags);
      expect(service.syncTags).toHaveBeenCalledWith(
        'crux-key',
        ['tag1', 'tag2'],
        'author-123',
      );
    });

    it('should throw ForbiddenException when author does not own crux', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findByKey.mockResolvedValue(mockCrux);

      await expect(
        controller.syncTags('crux-key', syncDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('canManageCrux', () => {
    it('should return true when author owns crux', async () => {
      service.findByKey.mockResolvedValue(mockCrux);

      const result = await controller.canManageCrux(
        'crux-key',
        mockAuthor as any,
      );

      expect(result).toBe(true);
    });

    it('should throw ForbiddenException when author does not own crux', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      service.findByKey.mockResolvedValue(mockCrux);

      await expect(
        controller.canManageCrux('crux-key', otherAuthor as any),
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

  describe('getCruxByKey', () => {
    it('should return crux when found', async () => {
      service.findByKey.mockResolvedValue(mockCrux);

      const result = await controller.getCruxByKey('crux-key');

      expect(result).toEqual(mockCrux);
    });

    it('should throw NotFoundException when crux not found', async () => {
      service.findByKey.mockResolvedValue(null);

      await expect(controller.getCruxByKey('invalid-key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
