import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthorController } from './author.controller';
import { AuthorService } from './author.service';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { AuthRequest } from '../common/types/interfaces';
import { AccountRole } from '../common/types/enums';

describe('AuthorController', () => {
  let controller: AuthorController;
  let service: jest.Mocked<AuthorService>;
  let dbService: jest.Mocked<DbService>;

  const mockAuthor = {
    id: 'author-id',
    key: 'author-key',
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
      findByKey: jest.fn(),
      findByUsername: jest.fn(),
      findAllQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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
      controllers: [AuthorController],
      providers: [
        { provide: AuthorService, useValue: mockService },
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    controller = module.get<AuthorController>(AuthorController);
    service = module.get(AuthorService);
    dbService = module.get(DbService);
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
    it('should return author by key', async () => {
      service.findByKey.mockResolvedValue(mockAuthor);

      const result = await controller.getByIdentifier('author-key');

      expect(result).toEqual(mockAuthor);
      expect(service.findByKey).toHaveBeenCalledWith('author-key');
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
      service.findByKey.mockResolvedValue(mockAuthor);
      service.update.mockResolvedValue(updatedAuthor);

      const result = await controller.update(
        'author-key',
        updateDto,
        mockRequest,
      );

      expect(result).toEqual(updatedAuthor);
      expect(service.update).toHaveBeenCalledWith('author-key', updateDto);
    });

    it('should throw ForbiddenException when account does not own author', async () => {
      const otherAuthor = { ...mockAuthor, accountId: 'other-account-id' };
      service.findByKey.mockResolvedValue(otherAuthor);

      await expect(
        controller.update('author-key', updateDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when author not found', async () => {
      service.findByKey.mockResolvedValue(null);

      await expect(
        controller.update('author-key', updateDto, mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete an author when account owns it', async () => {
      service.findByKey.mockResolvedValue(mockAuthor);
      service.delete.mockResolvedValue(null);

      const result = await controller.delete('author-key', mockRequest);

      expect(result).toBeNull();
      expect(service.delete).toHaveBeenCalledWith('author-key');
    });

    it('should throw ForbiddenException when account does not own author', async () => {
      const otherAuthor = { ...mockAuthor, accountId: 'other-account-id' };
      service.findByKey.mockResolvedValue(otherAuthor);

      await expect(
        controller.delete('author-key', mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when author not found', async () => {
      service.findByKey.mockResolvedValue(null);

      await expect(
        controller.delete('author-key', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('canManageAuthor', () => {
    it('should return true when account owns author', async () => {
      service.findByKey.mockResolvedValue(mockAuthor);

      const result = await controller.canManageAuthor(
        'author-key',
        mockRequest,
      );

      expect(result).toBe(true);
    });

    it('should throw ForbiddenException when account does not own author', async () => {
      const otherAuthor = { ...mockAuthor, accountId: 'other-account-id' };
      service.findByKey.mockResolvedValue(otherAuthor);

      await expect(
        controller.canManageAuthor('author-key', mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when author not found', async () => {
      service.findByKey.mockResolvedValue(null);

      await expect(
        controller.canManageAuthor('author-key', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
