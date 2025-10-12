import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { AttachmentService } from './attachment.service';
import { AttachmentRepository } from './attachment.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { StoreService } from '../common/services/store.service';

describe('AttachmentService', () => {
  let service: AttachmentService;
  let repository: jest.Mocked<AttachmentRepository>;
  let storeService: jest.Mocked<StoreService>;

  const mockAttachmentRaw = {
    id: 'attachment-id-123',
    key: 'attachment-key-abc',
    type: 'image',
    kind: 'photo',
    meta: { caption: 'Test image' },
    resource_id: 'resource-123',
    resource_type: 'crux',
    author_id: 'author-123',
    home_id: 'home-123',
    encoding: '7bit',
    mime_type: 'image/jpeg',
    filename: 'test.jpg',
    size: 1024,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const mockFile: any = {
    fieldname: 'file',
    originalname: 'test.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    buffer: Buffer.from('test'),
    size: 1024,
  };

  beforeEach(async () => {
    const mockRepository = {
      findBy: jest.fn(),
      findByResource: jest.fn(),
      findAllQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const mockStoreService = {
      upload: jest.fn(),
      download: jest.fn(),
      delete: jest.fn(),
    };

    const mockKeyMaster = {
      generateId: jest.fn().mockReturnValue('generated-id'),
      generateKey: jest.fn().mockReturnValue('generated-key'),
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
        AttachmentService,
        { provide: AttachmentRepository, useValue: mockRepository },
        { provide: StoreService, useValue: mockStoreService },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    service = module.get<AttachmentService>(AttachmentService);
    repository = module.get(AttachmentRepository);
    storeService = module.get(StoreService);
  });

  describe('findById', () => {
    it('should return an attachment when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });

      const result = await service.findById('attachment-id-123');

      expect(result.id).toBe('attachment-id-123');
      expect(repository.findBy).toHaveBeenCalledWith('id', 'attachment-id-123');
    });

    it('should throw NotFoundException when attachment not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findById('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException on repository error', async () => {
      repository.findBy.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await expect(service.findById('attachment-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByKey', () => {
    it('should return an attachment when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });

      const result = await service.findByKey('attachment-key-abc');

      expect(result.key).toBe('attachment-key-abc');
      expect(repository.findBy).toHaveBeenCalledWith(
        'key',
        'attachment-key-abc',
      );
    });

    it('should throw NotFoundException when attachment not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findByKey('invalid-key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByResource', () => {
    it('should return attachments for a resource', async () => {
      repository.findByResource.mockResolvedValue({
        data: [mockAttachmentRaw],
        error: null,
      });

      const result = await service.findByResource('crux', 'resource-123');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('attachment-id-123');
      expect(repository.findByResource).toHaveBeenCalledWith(
        'crux',
        'resource-123',
      );
    });

    it('should throw InternalServerErrorException on error', async () => {
      repository.findByResource.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await expect(
        service.findByResource('crux', 'resource-123'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('create', () => {
    const createDto = {
      type: 'image',
      kind: 'photo',
      resourceId: 'resource-123',
      resourceType: 'crux',
      authorId: 'author-123',
      homeId: 'home-123',
      encoding: '7bit',
      mimeType: 'image/jpeg',
      filename: 'test.jpg',
      size: 1024,
    };

    it('should create an attachment successfully', async () => {
      repository.create.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });

      const result = await service.create(createDto);

      expect(result.id).toBe('attachment-id-123');
      expect(repository.create).toHaveBeenCalledWith({
        ...createDto,
        id: 'generated-id',
        key: 'generated-key',
      });
    });

    it('should throw InternalServerErrorException on create error', async () => {
      repository.create.mockResolvedValue({
        data: null,
        error: new Error('Create failed'),
      });

      await expect(service.create(createDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('update', () => {
    const updateDto = { filename: 'updated.jpg' };

    it('should update an attachment successfully', async () => {
      const updatedAttachment = {
        ...mockAttachmentRaw,
        filename: 'updated.jpg',
      };
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedAttachment,
        error: null,
      });

      const result = await service.update('attachment-key-abc', updateDto);

      expect(result.filename).toBe('updated.jpg');
      expect(repository.update).toHaveBeenCalledWith(
        mockAttachmentRaw.id,
        updateDto,
      );
    });

    it('should throw InternalServerErrorException on update error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: null,
        error: new Error('Update failed'),
      });

      await expect(service.update('attachment-key', updateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('delete', () => {
    it('should delete an attachment successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('attachment-key-abc');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith(mockAttachmentRaw.id);
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('attachment-key')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('validateFile', () => {
    it('should throw BadRequestException when file is missing', () => {
      expect(() => service.validateFile(null as any)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when file is too large', () => {
      const largeFile = { ...mockFile, size: 100 * 1024 * 1024 }; // 100MB

      expect(() => service.validateFile(largeFile)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when mimetype is missing', () => {
      const fileWithoutMimetype = { ...mockFile, mimetype: null };

      expect(() => service.validateFile(fileWithoutMimetype)).toThrow(
        BadRequestException,
      );
    });

    it('should not throw when file is valid', () => {
      expect(() => service.validateFile(mockFile)).not.toThrow();
    });
  });

  describe('getStoragePath', () => {
    it('should generate correct storage path with extension', () => {
      const attachment = {
        resourceType: 'crux',
        resourceId: 'resource-123',
        id: 'attachment-123',
        mimeType: 'image/jpeg',
      };

      const path = service.getStoragePath(attachment);

      expect(path).toBe('crux/resource-123/attachment-123.jpg');
    });

    it('should generate path without extension for unknown mime type', () => {
      const attachment = {
        resourceType: 'crux',
        resourceId: 'resource-123',
        id: 'attachment-123',
        mimeType: 'application/unknown',
      };

      const path = service.getStoragePath(attachment);

      expect(path).toBe('crux/resource-123/attachment-123');
    });
  });

  describe('createWithFile', () => {
    const uploadDto: any = {
      type: 'image',
      kind: 'photo',
    };

    it('should create attachment with file successfully', async () => {
      storeService.upload.mockResolvedValue(undefined);
      repository.create.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });

      const result = await service.createWithFile(
        'crux',
        'resource-123',
        'home-123',
        'author-123',
        uploadDto,
        mockFile,
      );

      expect(result.id).toBe('attachment-id-123');
      expect(storeService.upload).toHaveBeenCalled();
      expect(repository.create).toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException when storage upload fails', async () => {
      storeService.upload.mockRejectedValue(new Error('Upload failed'));

      await expect(
        service.createWithFile(
          'crux',
          'resource-123',
          'home-123',
          'author-123',
          uploadDto,
          mockFile,
        ),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should cleanup storage when database save fails', async () => {
      storeService.upload.mockResolvedValue(undefined);
      storeService.delete.mockResolvedValue(undefined);
      repository.create.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await expect(
        service.createWithFile(
          'crux',
          'resource-123',
          'home-123',
          'author-123',
          uploadDto,
          mockFile,
        ),
      ).rejects.toThrow(InternalServerErrorException);

      expect(storeService.delete).toHaveBeenCalled();
    });
  });

  describe('updateWithFile', () => {
    const updateDto: any = { type: 'document' };

    it('should update attachment without file', async () => {
      const updatedAttachment = { ...mockAttachmentRaw, type: 'document' };
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedAttachment,
        error: null,
      });

      const result = await service.updateWithFile(
        'attachment-key',
        updateDto,
        undefined,
      );

      expect(result.type).toBe('document');
      expect(storeService.upload).not.toHaveBeenCalled();
    });

    it('should update attachment with new file', async () => {
      const updatedAttachment = { ...mockAttachmentRaw, filename: 'new.jpg' };
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedAttachment,
        error: null,
      });
      storeService.upload.mockResolvedValue(undefined);

      const result = await service.updateWithFile(
        'attachment-key',
        updateDto,
        mockFile,
      );

      expect(storeService.upload).toHaveBeenCalled();
      expect(result.filename).toBe('new.jpg');
    });

    it('should throw InternalServerErrorException when upload fails', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });
      storeService.upload.mockRejectedValue(new Error('Upload failed'));

      await expect(
        service.updateWithFile('attachment-key', updateDto, mockFile),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('deleteWithFile', () => {
    it('should delete attachment and file successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });
      storeService.delete.mockResolvedValue(undefined);
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.deleteWithFile('attachment-key');

      expect(result).toBeNull();
      expect(storeService.delete).toHaveBeenCalled();
      expect(repository.delete).toHaveBeenCalled();
    });

    it('should continue with database deletion even if storage fails', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });
      storeService.delete.mockRejectedValue(new Error('Storage error'));
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.deleteWithFile('attachment-key');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalled();
    });
  });

  describe('downloadAttachment', () => {
    it('should download attachment successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });
      storeService.download.mockResolvedValue({
        data: Buffer.from('file content'),
      });

      const result = await service.downloadAttachment('attachment-key');

      expect(result.data).toBeDefined();
      expect(result.filename).toBe('test.jpg');
      expect(result.mimeType).toBe('image/jpeg');
      expect(storeService.download).toHaveBeenCalled();
    });

    it('should throw NotFoundException when storage download fails', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAttachmentRaw,
        error: null,
      });
      storeService.download.mockRejectedValue(new Error('Not found'));

      await expect(
        service.downloadAttachment('attachment-key'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('asAttachment', () => {
    it('should transform raw attachment to entity', () => {
      const result = service.asAttachment(mockAttachmentRaw);

      expect(result.id).toBe(mockAttachmentRaw.id);
      expect(result.resourceId).toBe(mockAttachmentRaw.resource_id);
      expect(result.mimeType).toBe(mockAttachmentRaw.mime_type);
    });
  });

  describe('asAttachments', () => {
    it('should transform array of raw attachments to entities', () => {
      const result = service.asAttachments([mockAttachmentRaw]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockAttachmentRaw.id);
    });
  });
});
