import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ArtifactService } from './artifact.service';
import { ArtifactRepository } from './artifact.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { StoreService } from '../common/services/store.service';

describe('ArtifactService', () => {
  let service: ArtifactService;
  let repository: jest.Mocked<ArtifactRepository>;
  let storeService: jest.Mocked<StoreService>;

  const mockArtifactRaw = {
    id: 'artifact-id-123',
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
        ArtifactService,
        { provide: ArtifactRepository, useValue: mockRepository },
        { provide: StoreService, useValue: mockStoreService },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    service = module.get<ArtifactService>(ArtifactService);
    repository = module.get(ArtifactRepository);
    storeService = module.get(StoreService);
  });

  describe('findById', () => {
    it('should return an artifact when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });

      const result = await service.findById('artifact-id-123');

      expect(result.id).toBe('artifact-id-123');
      expect(repository.findBy).toHaveBeenCalledWith('id', 'artifact-id-123');
    });

    it('should throw NotFoundException when artifact not found', async () => {
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

      await expect(service.findById('artifact-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByResource', () => {
    it('should return artifacts for a resource', async () => {
      repository.findByResource.mockResolvedValue({
        data: [mockArtifactRaw],
        error: null,
      });

      const result = await service.findByResource('crux', 'resource-123');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('artifact-id-123');
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

    it('should create an artifact successfully', async () => {
      repository.create.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });

      const result = await service.create(createDto);

      expect(result.id).toBe('artifact-id-123');
      expect(repository.create).toHaveBeenCalledWith({
        ...createDto,
        id: 'generated-id',
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

    it('should update an artifact successfully', async () => {
      const updatedArtifact = {
        ...mockArtifactRaw,
        filename: 'updated.jpg',
      };
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedArtifact,
        error: null,
      });

      const result = await service.update('artifact-id-123', updateDto);

      expect(result.filename).toBe('updated.jpg');
      expect(repository.update).toHaveBeenCalledWith(
        mockArtifactRaw.id,
        updateDto,
      );
    });

    it('should throw InternalServerErrorException on update error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: null,
        error: new Error('Update failed'),
      });

      await expect(
        service.update('artifact-id-123', updateDto),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('delete', () => {
    it('should delete an artifact successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('artifact-id-123');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith(mockArtifactRaw.id);
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('artifact-id-123')).rejects.toThrow(
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
      const artifact = {
        resourceType: 'crux',
        resourceId: 'resource-123',
        id: 'artifact-123',
        mimeType: 'image/jpeg',
      };

      const path = service.getStoragePath(artifact);

      expect(path).toBe('crux/resource-123/artifact-123.jpg');
    });

    it('should generate path without extension for unknown mime type', () => {
      const artifact = {
        resourceType: 'crux',
        resourceId: 'resource-123',
        id: 'artifact-123',
        mimeType: 'application/unknown',
      };

      const path = service.getStoragePath(artifact);

      expect(path).toBe('crux/resource-123/artifact-123');
    });
  });

  describe('createWithFile', () => {
    const uploadDto: any = {
      type: 'image',
      kind: 'photo',
    };

    it('should create artifact with file successfully', async () => {
      storeService.upload.mockResolvedValue(undefined);
      repository.create.mockResolvedValue({
        data: mockArtifactRaw,
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

      expect(result.id).toBe('artifact-id-123');
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

    it('should update artifact without file', async () => {
      const updatedArtifact = { ...mockArtifactRaw, type: 'document' };
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedArtifact,
        error: null,
      });

      const result = await service.updateWithFile(
        'artifact-id-123',
        updateDto,
        undefined,
      );

      expect(result.type).toBe('document');
      expect(storeService.upload).not.toHaveBeenCalled();
    });

    it('should update artifact with new file', async () => {
      const updatedArtifact = { ...mockArtifactRaw, filename: 'new.jpg' };
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedArtifact,
        error: null,
      });
      storeService.upload.mockResolvedValue(undefined);

      const result = await service.updateWithFile(
        'artifact-id-123',
        updateDto,
        mockFile,
      );

      expect(storeService.upload).toHaveBeenCalled();
      expect(result.filename).toBe('new.jpg');
    });

    it('should throw InternalServerErrorException when upload fails', async () => {
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });
      storeService.upload.mockRejectedValue(new Error('Upload failed'));

      await expect(
        service.updateWithFile('artifact-id-123', updateDto, mockFile),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('deleteWithFile', () => {
    it('should delete artifact and file successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });
      storeService.delete.mockResolvedValue(undefined);
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.deleteWithFile('artifact-id-123');

      expect(result).toBeNull();
      expect(storeService.delete).toHaveBeenCalled();
      expect(repository.delete).toHaveBeenCalled();
    });

    it('should continue with database deletion even if storage fails', async () => {
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });
      storeService.delete.mockRejectedValue(new Error('Storage error'));
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.deleteWithFile('artifact-id-123');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalled();
    });
  });

  describe('downloadArtifact', () => {
    it('should download artifact successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });
      storeService.download.mockResolvedValue({
        data: Buffer.from('file content'),
      });

      const result = await service.downloadArtifact('artifact-id-123');

      expect(result.data).toBeDefined();
      expect(result.filename).toBe('test.jpg');
      expect(result.mimeType).toBe('image/jpeg');
      expect(storeService.download).toHaveBeenCalled();
    });

    it('should throw NotFoundException when storage download fails', async () => {
      repository.findBy.mockResolvedValue({
        data: mockArtifactRaw,
        error: null,
      });
      storeService.download.mockRejectedValue(new Error('Not found'));

      await expect(
        service.downloadArtifact('artifact-id-123'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('asArtifact', () => {
    it('should transform raw artifact to entity', () => {
      const result = service.asArtifact(mockArtifactRaw);

      expect(result.id).toBe(mockArtifactRaw.id);
      expect(result.resourceId).toBe(mockArtifactRaw.resource_id);
      expect(result.mimeType).toBe(mockArtifactRaw.mime_type);
    });
  });

  describe('asArtifacts', () => {
    it('should transform array of raw artifacts to entities', () => {
      const result = service.asArtifacts([mockArtifactRaw]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockArtifactRaw.id);
    });
  });
});
