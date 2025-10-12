import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { AttachmentRepository } from '../src/attachment/attachment.repository';
import { AuthorRepository } from '../src/author/author.repository';
import { HomeService } from '../src/home/home.service';
import { StoreService } from '../src/common/services/store.service';
import { DbService } from '../src/common/services/db.service';
import { MockDbService } from './mocks/db.mock';
import { success } from '../src/common/helpers/repository-helpers';
import AttachmentRaw from '../src/attachment/entities/attachment-raw.entity';
import AuthorRaw from '../src/author/entities/author-raw.entity';

describe('Attachment Integration Tests', () => {
  let app: INestApplication;
  let mockAttachmentRepository: jest.Mocked<AttachmentRepository>;
  let mockAuthorRepository: jest.Mocked<AuthorRepository>;
  let mockStoreService: jest.Mocked<StoreService>;

  const testAccountId = 'account-123';
  const testAuthorId = 'author-123';
  const testAttachmentId = 'attachment-123';
  const testAttachmentKey = 'attach-key-abc';

  const testAuthorRaw: AuthorRaw = {
    id: testAuthorId,
    key: 'author-key',
    username: 'testuser',
    display_name: 'Test User',
    account_id: testAccountId,
    home_id: 'home-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const testAttachmentRaw: AttachmentRaw = {
    id: testAttachmentId,
    key: testAttachmentKey,
    type: 'image',
    kind: 'photo',
    meta: { caption: 'Test image' },
    resource_id: 'resource-123',
    resource_type: 'crux',
    author_id: testAuthorId,
    home_id: 'home-123',
    encoding: '7bit',
    mime_type: 'image/jpeg',
    filename: 'test.jpg',
    size: 1024,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const generateToken = (accountId: string): string => {
    return jwt.sign(
      { id: accountId, email: 'test@example.com', role: 'author' },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '1h' },
    );
  };

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    // Create mock repositories
    mockAttachmentRepository = {
      findBy: jest.fn(),
      findByResource: jest.fn(),
      findAllQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as any;

    mockAuthorRepository = {
      findBy: jest.fn(),
      create: jest.fn(),
    } as any;

    mockStoreService = {
      upload: jest.fn(),
      download: jest.fn(),
      delete: jest.fn(),
    } as any;

    const mockHomeService = {
      primary: jest.fn().mockResolvedValue({
        id: 'home-123',
        key: 'home-key',
        name: 'Test Home',
        primary: true,
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DbService)
      .useValue(new MockDbService())
      .overrideProvider(AttachmentRepository)
      .useValue(mockAttachmentRepository)
      .overrideProvider(AuthorRepository)
      .useValue(mockAuthorRepository)
      .overrideProvider(StoreService)
      .useValue(mockStoreService)
      .overrideProvider(HomeService)
      .useValue(mockHomeService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();

    // Set environment
    process.env.JWT_SECRET = 'test-secret';
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('PUT /attachments/:attachmentKey', () => {
    const updateDto = {
      type: 'document',
    };

    it('should return 200 and update attachment without file (happy path)', async () => {
      const token = generateToken(testAccountId);
      const updatedAttachment = { ...testAttachmentRaw, type: 'document' };

      mockAttachmentRepository.findBy.mockResolvedValue(
        success(testAttachmentRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockAttachmentRepository.update.mockResolvedValue(
        success(updatedAttachment),
      );

      const response = await request(app.getHttpServer())
        .put(`/attachments/${testAttachmentKey}`)
        .set(authHeader(token))
        .send(updateDto)
        .expect(200);

      expect(response.body.type).toBe('document');
      expect(mockAttachmentRepository.update).toHaveBeenCalledWith(
        testAttachmentId,
        expect.objectContaining(updateDto),
      );
      expect(mockStoreService.upload).not.toHaveBeenCalled();
    });

    it('should return 200 and update attachment with file', async () => {
      const token = generateToken(testAccountId);
      const updatedAttachment = {
        ...testAttachmentRaw,
        filename: 'newfile.jpg',
      };

      mockAttachmentRepository.findBy.mockResolvedValue(
        success(testAttachmentRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockStoreService.upload.mockResolvedValue(undefined);
      mockAttachmentRepository.update.mockResolvedValue(
        success(updatedAttachment),
      );

      const response = await request(app.getHttpServer())
        .put(`/attachments/${testAttachmentKey}`)
        .set(authHeader(token))
        .field('type', 'document')
        .attach('file', Buffer.from('test file content'), 'newfile.jpg')
        .expect(200);

      expect(response.body.filename).toBe('newfile.jpg');
      expect(mockStoreService.upload).toHaveBeenCalled();
      expect(mockAttachmentRepository.update).toHaveBeenCalled();
    });

    it('should return 404 when attachment not found', async () => {
      const token = generateToken(testAccountId);
      mockAttachmentRepository.findBy.mockResolvedValue(success(null));
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));

      await request(app.getHttpServer())
        .put('/attachments/nonexistent')
        .set(authHeader(token))
        .send(updateDto)
        .expect(404);
    });

    it('should return 403 when user does not own attachment', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAttachmentRepository.findBy.mockResolvedValue(
        success(testAttachmentRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));

      await request(app.getHttpServer())
        .put(`/attachments/${testAttachmentKey}`)
        .set(authHeader(token))
        .send(updateDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .put(`/attachments/${testAttachmentKey}`)
        .send(updateDto)
        .expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .put(`/attachments/${testAttachmentKey}`)
        .set(authHeader('invalid-token'))
        .send(updateDto)
        .expect(401);
    });
  });

  describe('DELETE /attachments/:attachmentKey', () => {
    it('should return 204 and delete attachment with file (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockAttachmentRepository.findBy.mockResolvedValue(
        success(testAttachmentRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockStoreService.delete.mockResolvedValue(undefined);
      mockAttachmentRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/attachments/${testAttachmentKey}`)
        .set(authHeader(token))
        .expect(204);

      expect(mockStoreService.delete).toHaveBeenCalled();
      expect(mockAttachmentRepository.delete).toHaveBeenCalledWith(
        testAttachmentId,
      );
    });

    it('should return 204 even if storage deletion fails', async () => {
      const token = generateToken(testAccountId);

      mockAttachmentRepository.findBy.mockResolvedValue(
        success(testAttachmentRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockStoreService.delete.mockRejectedValue(new Error('Storage error'));
      mockAttachmentRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/attachments/${testAttachmentKey}`)
        .set(authHeader(token))
        .expect(204);

      expect(mockAttachmentRepository.delete).toHaveBeenCalled();
    });

    it('should return 404 when attachment not found', async () => {
      const token = generateToken(testAccountId);
      mockAttachmentRepository.findBy.mockResolvedValue(success(null));
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));

      await request(app.getHttpServer())
        .delete('/attachments/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 403 when user does not own attachment', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAttachmentRepository.findBy.mockResolvedValue(
        success(testAttachmentRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));

      await request(app.getHttpServer())
        .delete(`/attachments/${testAttachmentKey}`)
        .set(authHeader(token))
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .delete(`/attachments/${testAttachmentKey}`)
        .expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .delete(`/attachments/${testAttachmentKey}`)
        .set(authHeader('invalid-token'))
        .expect(401);
    });
  });

  describe('Edge Cases', () => {
    it('should handle large file size validation', async () => {
      const token = generateToken(testAccountId);

      mockAttachmentRepository.findBy.mockResolvedValue(
        success(testAttachmentRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));

      // Create a buffer larger than MAX_ATTACHMENT_SIZE (50MB)
      const largeBuffer = Buffer.alloc(51 * 1024 * 1024);

      await request(app.getHttpServer())
        .put(`/attachments/${testAttachmentKey}`)
        .set(authHeader(token))
        .field('type', 'document')
        .attach('file', largeBuffer, 'large.jpg')
        .expect(400);
    });

    it('should handle missing author gracefully', async () => {
      const token = generateToken(testAccountId);

      mockAttachmentRepository.findBy.mockResolvedValue(
        success(testAttachmentRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .put(`/attachments/${testAttachmentKey}`)
        .set(authHeader(token))
        .send({ type: 'document' })
        .expect(404);
    });

    it('should handle storage upload failure', async () => {
      const token = generateToken(testAccountId);

      mockAttachmentRepository.findBy.mockResolvedValue(
        success(testAttachmentRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockStoreService.upload.mockRejectedValue(new Error('Upload failed'));

      await request(app.getHttpServer())
        .put(`/attachments/${testAttachmentKey}`)
        .set(authHeader(token))
        .field('type', 'document')
        .attach('file', Buffer.from('test'), 'test.jpg')
        .expect(500);
    });

    it('should handle database update failure', async () => {
      const token = generateToken(testAccountId);

      mockAttachmentRepository.findBy.mockResolvedValue(
        success(testAttachmentRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockAttachmentRepository.update.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await request(app.getHttpServer())
        .put(`/attachments/${testAttachmentKey}`)
        .set(authHeader(token))
        .send({ type: 'document' })
        .expect(500);
    });

    it('should handle database delete failure', async () => {
      const token = generateToken(testAccountId);

      mockAttachmentRepository.findBy.mockResolvedValue(
        success(testAttachmentRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockStoreService.delete.mockResolvedValue(undefined);
      mockAttachmentRepository.delete.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await request(app.getHttpServer())
        .delete(`/attachments/${testAttachmentKey}`)
        .set(authHeader(token))
        .expect(500);
    });
  });
});
