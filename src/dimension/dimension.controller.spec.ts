import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DimensionController } from './dimension.controller';
import { DimensionService } from './dimension.service';
import { AuthorService } from '../author/author.service';
import { LoggerService } from '../common/services/logger.service';
import { AuthRequest } from '../common/types/interfaces';
import { AccountRole } from '../common/types/enums';

describe('DimensionController', () => {
  let controller: DimensionController;
  let service: jest.Mocked<DimensionService>;
  let authorService: jest.Mocked<AuthorService>;

  const mockDimension = {
    id: 'dimension-id',
    key: 'dimension-key',
    sourceId: 'crux-source-123',
    targetId: 'crux-target-456',
    type: 'gate' as const,
    weight: 1,
    authorId: 'author-123',
    homeId: 'home-id-123',
    note: 'test dimension',
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

  beforeEach(async () => {
    const mockService = {
      findByKey: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const mockAuthorService = {
      findByAccountId: jest.fn(),
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
      controllers: [DimensionController],
      providers: [
        { provide: DimensionService, useValue: mockService },
        { provide: AuthorService, useValue: mockAuthorService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    controller = module.get<DimensionController>(DimensionController);
    service = module.get(DimensionService);
    authorService = module.get(AuthorService);
  });

  describe('getByKey', () => {
    it('should return a dimension by key', async () => {
      service.findByKey.mockResolvedValue(mockDimension);

      const result = await controller.getByKey('dimension-key');

      expect(result).toEqual(mockDimension);
      expect(service.findByKey).toHaveBeenCalledWith('dimension-key');
    });
  });

  describe('update', () => {
    const updateDto = { type: 'garden' as any, weight: 2 };

    it('should update a dimension when author owns it', async () => {
      const updatedDimension = { ...mockDimension, type: 'garden' as const };
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findByKey.mockResolvedValue(mockDimension);
      service.update.mockResolvedValue(updatedDimension);

      const result = await controller.update(
        'dimension-key',
        updateDto,
        mockRequest,
      );

      expect(result).toEqual(updatedDimension);
      expect(service.update).toHaveBeenCalledWith('dimension-key', updateDto);
    });

    it('should throw ForbiddenException when author does not own dimension', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findByKey.mockResolvedValue(mockDimension);

      await expect(
        controller.update('dimension-key', updateDto, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when author not found', async () => {
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(
        controller.update('dimension-key', updateDto, mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete a dimension when author owns it', async () => {
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      service.findByKey.mockResolvedValue(mockDimension);
      service.delete.mockResolvedValue(null);

      const result = await controller.delete('dimension-key', mockRequest);

      expect(result).toBeNull();
      expect(service.delete).toHaveBeenCalledWith('dimension-key');
    });

    it('should throw ForbiddenException when author does not own dimension', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      authorService.findByAccountId.mockResolvedValue(otherAuthor as any);
      service.findByKey.mockResolvedValue(mockDimension);

      await expect(
        controller.delete('dimension-key', mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when author not found', async () => {
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(
        controller.delete('dimension-key', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('canManageDimension', () => {
    it('should return true when author owns dimension', async () => {
      service.findByKey.mockResolvedValue(mockDimension);

      const result = await controller.canManageDimension(
        'dimension-key',
        mockAuthor as any,
      );

      expect(result).toBe(true);
    });

    it('should throw ForbiddenException when author does not own dimension', async () => {
      const otherAuthor = { ...mockAuthor, id: 'other-author-id' };
      service.findByKey.mockResolvedValue(mockDimension);

      await expect(
        controller.canManageDimension('dimension-key', otherAuthor as any),
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
});
