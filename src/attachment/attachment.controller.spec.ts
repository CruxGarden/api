import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { AuthorService } from '../author/author.service';
import { LoggerService } from '../common/services/logger.service';
import { AuthRequest } from '../common/types/interfaces';
import { AccountRole } from '../common/types/enums';

describe('AttachmentController', () => {
  let controller: AttachmentController;
  let attachmentService: jest.Mocked<AttachmentService>;
  let authorService: jest.Mocked<AuthorService>;

  const mockAttachment = {
    id: 'attachment-id',
    key: 'attachment-key',
    type: 'image',
    kind: 'photo',
    meta: { caption: 'Test' },
    resourceId: 'resource-123',
    resourceType: 'crux',
    authorId: 'author-123',
    homeId: 'home-123',
    encoding: '7bit',
    mimeType: 'image/jpeg',
    filename: 'test.jpg',
    size: 1024,
    created: new Date(),
    updated: new Date(),
    deleted: null,
    toJSON: jest.fn().mockReturnThis(),
  };

  const mockAuthor = {
    id: 'author-123',
    key: 'author-key',
    accountId: 'account-123',
    username: 'testuser',
    displayName: 'Test User',
    bio: null,
    homeId: 'home-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const mockRequest: AuthRequest = {
    account: {
      id: 'account-123',
      email: 'test@example.com',
      role: AccountRole.AUTHOR,
    },
  } as any;

  const mockFile: any = {
    fieldname: 'file',
    originalname: 'test.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    buffer: Buffer.from('test'),
    size: 1024,
  };

  beforeEach(async () => {
    const mockAttachmentService = {
      findByKey: jest.fn(),
      updateWithFile: jest.fn(),
      deleteWithFile: jest.fn(),
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
      controllers: [AttachmentController],
      providers: [
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: AuthorService, useValue: mockAuthorService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    controller = module.get<AttachmentController>(AttachmentController);
    attachmentService = module.get(AttachmentService);
    authorService = module.get(AuthorService);
  });

  describe('update', () => {
    const updateDto: any = { type: 'document' };

    it('should update attachment when author owns it', async () => {
      const updatedAttachment = { ...mockAttachment, type: 'document' };
      attachmentService.findByKey.mockResolvedValue(mockAttachment);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      attachmentService.updateWithFile.mockResolvedValue(
        updatedAttachment as any,
      );

      const result = await controller.update(
        'attachment-key',
        updateDto,
        mockFile,
        mockRequest,
      );

      expect(result).toEqual(updatedAttachment);
      expect(attachmentService.updateWithFile).toHaveBeenCalledWith(
        'attachment-key',
        updateDto,
        mockFile,
      );
    });

    it('should throw ForbiddenException when author does not own attachment', async () => {
      const otherAttachment = { ...mockAttachment, authorId: 'other-author' };
      attachmentService.findByKey.mockResolvedValue(otherAttachment);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.update('attachment-key', updateDto, mockFile, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when attachment not found', async () => {
      attachmentService.findByKey.mockResolvedValue(null);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.update('attachment-key', updateDto, mockFile, mockRequest),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when author not found', async () => {
      attachmentService.findByKey.mockResolvedValue(mockAttachment);
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(
        controller.update('attachment-key', updateDto, mockFile, mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete attachment when author owns it', async () => {
      attachmentService.findByKey.mockResolvedValue(mockAttachment);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      attachmentService.deleteWithFile.mockResolvedValue(null);

      const result = await controller.delete('attachment-key', mockRequest);

      expect(result).toBeNull();
      expect(attachmentService.deleteWithFile).toHaveBeenCalledWith(
        'attachment-key',
      );
    });

    it('should throw ForbiddenException when author does not own attachment', async () => {
      const otherAttachment = { ...mockAttachment, authorId: 'other-author' };
      attachmentService.findByKey.mockResolvedValue(otherAttachment);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.delete('attachment-key', mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when attachment not found', async () => {
      attachmentService.findByKey.mockResolvedValue(null);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.delete('attachment-key', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when author not found', async () => {
      attachmentService.findByKey.mockResolvedValue(mockAttachment);
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(
        controller.delete('attachment-key', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('canManageAttachment', () => {
    it('should not throw when author owns attachment', async () => {
      attachmentService.findByKey.mockResolvedValue(mockAttachment);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.canManageAttachment('attachment-key', mockRequest),
      ).resolves.not.toThrow();
    });

    it('should throw ForbiddenException when author does not own attachment', async () => {
      const otherAttachment = { ...mockAttachment, authorId: 'other-author' };
      attachmentService.findByKey.mockResolvedValue(otherAttachment);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.canManageAttachment('attachment-key', mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when attachment not found', async () => {
      attachmentService.findByKey.mockResolvedValue(null);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.canManageAttachment('attachment-key', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when author not found', async () => {
      attachmentService.findByKey.mockResolvedValue(mockAttachment);
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(
        controller.canManageAttachment('attachment-key', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
