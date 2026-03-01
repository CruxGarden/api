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
      findById: jest.fn(),
      findByIdentifier: jest.fn(),
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

  describe('getByIdentifier', () => {
    it('should return a crux by identifier', async () => {
      service.findByIdentifier.mockResolvedValue(mockCrux);

      const result = await controller.getByIdentifier('crux-id');

      expect(result).toEqual(mockCrux);
      expect(service.findByIdentifier).toHaveBeenCalledWith('crux-id');
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
      service.findById.mockResolvedValue(mockCrux);
      service.update.mockResolvedValue(updatedCrux);

      const result = await controller.update('crux-id', updateDto, mockRequest);

      expect(result).toEqual(updatedCrux);
      expect(service.update).toHaveBeenCalledWith('crux-id', updateDto);
    });

    it('should throw ForbiddenException when author does not own crux', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findById.mockResolvedValue(mockCrux);

      await expect(
        controller.update('crux-id', updateDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when author not found', async () => {
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(
        controller.update('crux-id', updateDto, mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete a crux when author owns it', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findById.mockResolvedValue(mockCrux);
      service.delete.mockResolvedValue(null);

      const result = await controller.delete('crux-id', mockRequest);

      expect(result).toBeNull();
      expect(service.delete).toHaveBeenCalledWith('crux-id');
    });

    it('should throw ForbiddenException when author does not own crux', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findById.mockResolvedValue(mockCrux);

      await expect(controller.delete('crux-id', mockRequest)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('getDimensions', () => {
    it('should return paginated dimensions for a crux', async () => {
      const query = {} as any;
      service.findById.mockResolvedValue(mockCrux);
      service.getDimensionsQuery.mockReturnValue(query);
      dbService.paginate.mockResolvedValue([mockDimension]);

      const result = await controller.getDimensions(
        mockRequest,
        mockResponse,
        'crux-id',
        DimensionType.GATE,
      );

      expect(result).toEqual([mockDimension]);
      expect(service.getDimensionsQuery).toHaveBeenCalledWith(
        'crux-id',
        DimensionType.GATE,
        false,
        true,
      );
    });

    it('should throw NotFoundException when crux not found', async () => {
      service.findById.mockResolvedValue(null);

      await expect(
        controller.getDimensions(mockRequest, mockResponse, 'invalid-id'),
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
      service.findById.mockResolvedValue(mockCrux);
      service.createDimension.mockResolvedValue(mockDimension as any);

      const result = await controller.createDimension(
        'crux-id',
        createDimensionDto,
        mockRequest,
      );

      expect(result).toEqual(mockDimension);
      expect(service.createDimension).toHaveBeenCalledWith('crux-id', {
        ...createDimensionDto,
        authorId: 'author-123',
      });
    });

    it('should throw ForbiddenException when author does not own crux', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findById.mockResolvedValue(mockCrux);

      await expect(
        controller.createDimension('crux-id', createDimensionDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getTags', () => {
    it('should return tags for a crux', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      service.getTags.mockResolvedValue(mockTags);

      const result = await controller.getTags('crux-id', 'filter');

      expect(result).toEqual(mockTags);
      expect(service.getTags).toHaveBeenCalledWith('crux-id', 'filter');
    });

    it('should throw NotFoundException when crux not found', async () => {
      service.getTags.mockRejectedValue(
        new NotFoundException('Crux not found'),
      );

      await expect(controller.getTags('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('syncTags', () => {
    const syncDto = { labels: ['tag1', 'tag2'] };

    it('should sync tags when author owns crux', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findById.mockResolvedValue(mockCrux);
      service.syncTags.mockResolvedValue(mockTags);

      const result = await controller.syncTags('crux-id', syncDto, mockRequest);

      expect(result).toEqual(mockTags);
      expect(service.syncTags).toHaveBeenCalledWith(
        'crux-id',
        ['tag1', 'tag2'],
        'author-123',
      );
    });

    it('should throw ForbiddenException when author does not own crux', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findById.mockResolvedValue(mockCrux);

      await expect(
        controller.syncTags('crux-id', syncDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('canManageCrux', () => {
    it('should return true when author owns crux', async () => {
      service.findById.mockResolvedValue(mockCrux);

      const result = await controller.canManageCrux(
        'crux-id',
        mockAuthor as any,
      );

      expect(result).toBe(true);
    });

    it('should throw ForbiddenException when author does not own crux', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      service.findById.mockResolvedValue(mockCrux);

      await expect(
        controller.canManageCrux('crux-id', otherAuthor as any),
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

  describe('getCruxById', () => {
    it('should return crux when found', async () => {
      service.findById.mockResolvedValue(mockCrux);

      const result = await controller.getCruxById('crux-id');

      expect(result).toEqual(mockCrux);
    });

    it('should throw NotFoundException when crux not found', async () => {
      service.findById.mockResolvedValue(null);

      await expect(controller.getCruxById('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
