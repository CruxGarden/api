import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthorController } from './author.controller';
import { AuthorService } from './author.service';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { CruxService } from '../crux/crux.service';
import { AuthRequest } from '../common/types/interfaces';
import { AccountRole } from '../common/types/enums';

describe('AuthorController', () => {
  let controller: AuthorController;
  let service: jest.Mocked<AuthorService>;
  let dbService: jest.Mocked<DbService>;
  let cruxService: jest.Mocked<CruxService>;

  const mockAuthor = {
    id: 'author-id',
    accountId: 'account-123',
    username: 'testuser',
    displayName: 'Test User',
    bio: 'A test bio',
    homeId: 'crux-home-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
    toJSON: jest.fn().mockReturnThis(),
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
      findByUsername: jest.fn(),
      findAllQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const mockDbService = {
      paginate: jest.fn(),
    };

    const mockCruxService = {
      findById: jest.fn(),
      findByAuthorAndSlug: jest.fn(),
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
      controllers: [AuthorController],
      providers: [
        { provide: AuthorService, useValue: mockService },
        { provide: DbService, useValue: mockDbService },
        { provide: CruxService, useValue: mockCruxService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    controller = module.get<AuthorController>(AuthorController);
    service = module.get(AuthorService);
    dbService = module.get(DbService);
    cruxService = module.get(CruxService);
  });

  describe('getAll', () => {
    it('should return paginated authors', async () => {
      const query = {} as any;
      service.findAllQuery.mockReturnValue(query);
      dbService.paginate.mockResolvedValue([mockAuthor]);

      const result = await controller.getAll(mockRequest, mockResponse);

      expect(result).toEqual([mockAuthor]);
      expect(service.findAllQuery).toHaveBeenCalled();
      expect(dbService.paginate).toHaveBeenCalled();
    });
  });

  describe('getByIdentifier', () => {
    it('should return author by id', async () => {
      service.findById.mockResolvedValue(mockAuthor);

      const result = await controller.getByIdentifier('author-id');

      expect(result).toEqual(mockAuthor);
      expect(service.findById).toHaveBeenCalledWith('author-id');
    });

    it('should return author by username when prefixed with @', async () => {
      service.findByUsername.mockResolvedValue(mockAuthor);

      const result = await controller.getByIdentifier('@testuser');

      expect(result).toEqual(mockAuthor);
      expect(service.findByUsername).toHaveBeenCalledWith('testuser');
    });
  });

  describe('create', () => {
    const createDto = {
      username: 'newuser',
      displayName: 'New User',
    } as any;

    it('should create an author successfully', async () => {
      service.create.mockResolvedValue(mockAuthor);

      const result = await controller.create(createDto, mockRequest);

      expect(result).toEqual(mockAuthor);
      expect(service.create).toHaveBeenCalledWith({
        ...createDto,
        accountId: 'account-123',
      });
    });
  });

  describe('update', () => {
    const updateDto = { displayName: 'Updated Name' };

    it('should update an author when account owns it', async () => {
      const updatedAuthor = { ...mockAuthor, displayName: 'Updated Name' };
      service.findById.mockResolvedValue(mockAuthor);
      service.update.mockResolvedValue(updatedAuthor);

      const result = await controller.update(
        'author-id',
        updateDto,
        mockRequest,
      );

      expect(result).toEqual(updatedAuthor);
      expect(service.update).toHaveBeenCalledWith('author-id', updateDto);
    });

    it('should throw ForbiddenException when account does not own author', async () => {
      const otherAuthor = { ...mockAuthor, accountId: 'other-account-id' };
      service.findById.mockResolvedValue(otherAuthor);

      await expect(
        controller.update('author-id', updateDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when author not found', async () => {
      service.findById.mockResolvedValue(null);

      await expect(
        controller.update('author-id', updateDto, mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete an author when account owns it', async () => {
      service.findById.mockResolvedValue(mockAuthor);
      service.delete.mockResolvedValue(null);

      const result = await controller.delete('author-id', mockRequest);

      expect(result).toBeNull();
      expect(service.delete).toHaveBeenCalledWith('author-id');
    });

    it('should throw ForbiddenException when account does not own author', async () => {
      const otherAuthor = { ...mockAuthor, accountId: 'other-account-id' };
      service.findById.mockResolvedValue(otherAuthor);

      await expect(controller.delete('author-id', mockRequest)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw NotFoundException when author not found', async () => {
      service.findById.mockResolvedValue(null);

      await expect(controller.delete('author-id', mockRequest)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('canManageAuthor', () => {
    it('should return true when account owns author', async () => {
      service.findById.mockResolvedValue(mockAuthor);

      const result = await controller.canManageAuthor('author-id', mockRequest);

      expect(result).toBe(true);
    });

    it('should throw ForbiddenException when account does not own author', async () => {
      const otherAuthor = { ...mockAuthor, accountId: 'other-account-id' };
      service.findById.mockResolvedValue(otherAuthor);

      await expect(
        controller.canManageAuthor('author-id', mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when author not found', async () => {
      service.findById.mockResolvedValue(null);

      await expect(
        controller.canManageAuthor('author-id', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getCruxBySlug', () => {
    const mockCrux = {
      id: 'crux-id',
      slug: 'test-crux',
      title: 'Test Crux',
      data: 'Test content',
      authorId: 'author-id',
      homeId: 'home-id',
      accountId: 'account-123',
      created: new Date(),
      updated: new Date(),
    };

    it('should return crux by author username and slug', async () => {
      service.findByUsername.mockResolvedValue(mockAuthor);
      cruxService.findByAuthorAndSlug.mockResolvedValue(mockCrux as any);

      const result = await controller.getCruxBySlug('@testuser', 'test-crux');

      expect(result).toEqual(mockCrux);
      expect(service.findByUsername).toHaveBeenCalledWith('testuser');
      expect(cruxService.findByAuthorAndSlug).toHaveBeenCalledWith(
        'author-id',
        'test-crux',
      );
    });

    it('should return crux by author id and slug', async () => {
      service.findById.mockResolvedValue(mockAuthor);
      cruxService.findByAuthorAndSlug.mockResolvedValue(mockCrux as any);

      const result = await controller.getCruxBySlug('author-id', 'test-crux');

      expect(result).toEqual(mockCrux);
      expect(service.findById).toHaveBeenCalledWith('author-id');
      expect(cruxService.findByAuthorAndSlug).toHaveBeenCalledWith(
        'author-id',
        'test-crux',
      );
    });
  });
});
