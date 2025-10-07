import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { TagController } from './tag.controller';
import { TagService } from './tag.service';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { ResourceType, AccountRole } from '../common/types/enums';
import { AuthRequest } from '../common/types/interfaces';

describe('TagController', () => {
  let controller: TagController;
  let service: jest.Mocked<TagService>;
  let dbService: jest.Mocked<DbService>;

  const mockTag = {
    id: 'tag-id',
    key: 'tag-key',
    resourceType: ResourceType.CRUX,
    resourceId: 'crux-123',
    label: 'test-tag',
    authorId: 'author-123',
    system: false,
    created: new Date(),
    updated: new Date(),
    deleted: null,
    toJSON: jest.fn().mockReturnThis(),
  };

  const mockRequest: AuthRequest = {
    account: {
      id: 'account-123',
      email: 'test@example.com',
      role: AccountRole.ADMIN,
    },
  } as any;

  const mockResponse = {
    setHeader: jest.fn(),
  } as any;

  beforeEach(async () => {
    const mockService = {
      findAllQuery: jest.fn(),
      findByKey: jest.fn(),
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
      controllers: [TagController],
      providers: [
        { provide: TagService, useValue: mockService },
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    controller = module.get<TagController>(TagController);
    service = module.get(TagService);
    dbService = module.get(DbService);
  });

  describe('findAll', () => {
    it('should return paginated tags', async () => {
      const query = {} as any;
      service.findAllQuery.mockReturnValue(query);
      dbService.paginate.mockResolvedValue([mockTag]);

      const result = await controller.findAll(
        mockRequest,
        mockResponse,
        ResourceType.CRUX,
        'test',
        'count',
        'javascript',
      );

      expect(result).toEqual([mockTag]);
      expect(service.findAllQuery).toHaveBeenCalledWith(
        ResourceType.CRUX,
        'test',
        'count',
        'javascript',
      );
      expect(dbService.paginate).toHaveBeenCalled();
    });

    it('should use default sort when not provided', async () => {
      const query = {} as any;
      service.findAllQuery.mockReturnValue(query);
      dbService.paginate.mockResolvedValue([mockTag]);

      await controller.findAll(mockRequest, mockResponse);

      expect(service.findAllQuery).toHaveBeenCalledWith(
        undefined,
        undefined,
        'count',
        undefined,
      );
    });
  });

  describe('getByKey', () => {
    it('should return a tag by key', async () => {
      service.findByKey.mockResolvedValue(mockTag);

      const result = await controller.getByKey('tag-key');

      expect(result).toEqual(mockTag);
      expect(service.findByKey).toHaveBeenCalledWith('tag-key');
    });
  });

  describe('update', () => {
    const updateDto = { label: 'updated-tag' };

    it('should update a tag when user is admin', async () => {
      const updatedTag = { ...mockTag, label: 'updated-tag' };
      service.update.mockResolvedValue(updatedTag);

      const result = await controller.update('tag-key', updateDto, mockRequest);

      expect(result).toEqual(updatedTag);
      expect(service.update).toHaveBeenCalledWith('tag-key', updateDto);
    });

    it('should throw ForbiddenException when user is not admin', async () => {
      const nonAdminRequest = {
        ...mockRequest,
        account: { ...mockRequest.account, role: AccountRole.AUTHOR },
      } as any;

      await expect(
        controller.update('tag-key', updateDto, nonAdminRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('delete', () => {
    it('should delete a tag when user is admin', async () => {
      service.delete.mockResolvedValue(null);

      const result = await controller.delete('tag-key', mockRequest);

      expect(result).toBeNull();
      expect(service.delete).toHaveBeenCalledWith('tag-key');
    });

    it('should throw ForbiddenException when user is not admin', async () => {
      const nonAdminRequest = {
        ...mockRequest,
        account: { ...mockRequest.account, role: AccountRole.AUTHOR },
      } as any;

      await expect(
        controller.delete('tag-key', nonAdminRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('canManageTag', () => {
    it('should not throw when user is admin', async () => {
      await expect(controller.canManageTag(mockRequest)).resolves.not.toThrow();
    });

    it('should throw ForbiddenException when user is not admin', async () => {
      const nonAdminRequest = {
        ...mockRequest,
        account: { ...mockRequest.account, role: AccountRole.AUTHOR },
      } as any;

      await expect(controller.canManageTag(nonAdminRequest)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
