import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ArtifactController } from './artifact.controller';
import { ArtifactService } from './artifact.service';
import { AuthorService } from '../author/author.service';
import { LoggerService } from '../common/services/logger.service';
import { AuthRequest } from '../common/types/interfaces';
import { AccountRole } from '../common/types/enums';

describe('ArtifactController', () => {
  let controller: ArtifactController;
  let artifactService: jest.Mocked<ArtifactService>;
  let authorService: jest.Mocked<AuthorService>;

  const mockArtifact = {
    id: 'artifact-id',
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
    const mockArtifactService = {
      findById: jest.fn(),
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
      controllers: [ArtifactController],
      providers: [
        { provide: ArtifactService, useValue: mockArtifactService },
        { provide: AuthorService, useValue: mockAuthorService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    controller = module.get<ArtifactController>(ArtifactController);
    artifactService = module.get(ArtifactService);
    authorService = module.get(AuthorService);
  });

  describe('update', () => {
    const updateDto: any = { type: 'document' };

    it('should update artifact when author owns it', async () => {
      const updatedArtifact = { ...mockArtifact, type: 'document' };
      artifactService.findById.mockResolvedValue(mockArtifact);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      artifactService.updateWithFile.mockResolvedValue(updatedArtifact as any);

      const result = await controller.update(
        'artifact-id',
        updateDto,
        mockFile,
        mockRequest,
      );

      expect(result).toEqual(updatedArtifact);
      expect(artifactService.updateWithFile).toHaveBeenCalledWith(
        'artifact-id',
        updateDto,
        mockFile,
      );
    });

    it('should throw ForbiddenException when author does not own artifact', async () => {
      const otherArtifact = { ...mockArtifact, authorId: 'other-author' };
      artifactService.findById.mockResolvedValue(otherArtifact);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.update('artifact-id', updateDto, mockFile, mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when artifact not found', async () => {
      artifactService.findById.mockResolvedValue(null);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.update('artifact-id', updateDto, mockFile, mockRequest),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when author not found', async () => {
      artifactService.findById.mockResolvedValue(mockArtifact);
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(
        controller.update('artifact-id', updateDto, mockFile, mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete artifact when author owns it', async () => {
      artifactService.findById.mockResolvedValue(mockArtifact);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);
      artifactService.deleteWithFile.mockResolvedValue(null);

      const result = await controller.delete('artifact-id', mockRequest);

      expect(result).toBeNull();
      expect(artifactService.deleteWithFile).toHaveBeenCalledWith(
        'artifact-id',
      );
    });

    it('should throw ForbiddenException when author does not own artifact', async () => {
      const otherArtifact = { ...mockArtifact, authorId: 'other-author' };
      artifactService.findById.mockResolvedValue(otherArtifact);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.delete('artifact-id', mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when artifact not found', async () => {
      artifactService.findById.mockResolvedValue(null);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.delete('artifact-id', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when author not found', async () => {
      artifactService.findById.mockResolvedValue(mockArtifact);
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(
        controller.delete('artifact-id', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('canManageArtifact', () => {
    it('should not throw when author owns artifact', async () => {
      artifactService.findById.mockResolvedValue(mockArtifact);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.canManageArtifact('artifact-id', mockRequest),
      ).resolves.not.toThrow();
    });

    it('should throw ForbiddenException when author does not own artifact', async () => {
      const otherArtifact = { ...mockArtifact, authorId: 'other-author' };
      artifactService.findById.mockResolvedValue(otherArtifact);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.canManageArtifact('artifact-id', mockRequest),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when artifact not found', async () => {
      artifactService.findById.mockResolvedValue(null);
      authorService.findByAccountId.mockResolvedValue(mockAuthor as any);

      await expect(
        controller.canManageArtifact('artifact-id', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when author not found', async () => {
      artifactService.findById.mockResolvedValue(mockArtifact);
      authorService.findByAccountId.mockResolvedValue(null);

      await expect(
        controller.canManageArtifact('artifact-id', mockRequest),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
