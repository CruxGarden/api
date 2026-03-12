import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { ArtifactRepository } from '../src/artifact/artifact.repository';
import { AuthorRepository } from '../src/author/author.repository';
import { HomeService } from '../src/home/home.service';
import { StoreService } from '../src/common/services/store.service';
import { DbService } from '../src/common/services/db.service';
import { RedisService } from '../src/common/services/redis.service';
import { MockDbService } from './mocks/db.mock';
import { MockRedisService } from './mocks/redis.mock';
import { success } from '../src/common/helpers/repository-helpers';
import ArtifactRaw from '../src/artifact/entities/artifact-raw.entity';
import AuthorRaw from '../src/author/entities/author-raw.entity';

describe('Artifact Integration Tests', () => {
  let app: INestApplication;
  let mockArtifactRepository: jest.Mocked<ArtifactRepository>;
  let mockAuthorRepository: jest.Mocked<AuthorRepository>;
  let mockStoreService: jest.Mocked<StoreService>;

  const testAccountId = 'account-123';
  const testAuthorId = 'author-123';
  const testArtifactId = 'artifact-123';

  const testAuthorRaw: AuthorRaw = {
    id: testAuthorId,
    username: 'testuser',
    display_name: 'Test User',
    account_id: testAccountId,
    home_id: 'home-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const testArtifactRaw: ArtifactRaw = {
    id: testArtifactId,
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
    mockArtifactRepository = {
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
        name: 'Test Home',
        primary: true,
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DbService)
      .useValue(new MockDbService())
      .overrideProvider(RedisService)
      .useValue(new MockRedisService())
      .overrideProvider(ArtifactRepository)
      .useValue(mockArtifactRepository)
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

  describe('PUT /artifacts/:artifactId', () => {
    const updateDto = {
      type: 'document',
    };

    it('should return 200 and update artifact without file (happy path)', async () => {
      const token = generateToken(testAccountId);
      const updatedArtifact = { ...testArtifactRaw, type: 'document' };

      mockArtifactRepository.findBy.mockResolvedValue(
        success(testArtifactRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockArtifactRepository.update.mockResolvedValue(
        success(updatedArtifact),
      );

      const response = await request(app.getHttpServer())
        .put(`/artifacts/${testArtifactId}`)
        .set(authHeader(token))
        .send(updateDto)
        .expect(200);

      expect(response.body.type).toBe('document');
      expect(mockArtifactRepository.update).toHaveBeenCalledWith(
        testArtifactId,
        expect.objectContaining(updateDto),
      );
      expect(mockStoreService.upload).not.toHaveBeenCalled();
    });

    it('should return 200 and update artifact with file', async () => {
      const token = generateToken(testAccountId);
      const updatedArtifact = {
        ...testArtifactRaw,
        filename: 'newfile.jpg',
      };

      mockArtifactRepository.findBy.mockResolvedValue(
        success(testArtifactRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockStoreService.upload.mockResolvedValue(undefined);
      mockArtifactRepository.update.mockResolvedValue(
        success(updatedArtifact),
      );

      const response = await request(app.getHttpServer())
        .put(`/artifacts/${testArtifactId}`)
        .set(authHeader(token))
        .field('type', 'document')
        .attach('file', Buffer.from('test file content'), 'newfile.jpg')
        .expect(200);

      expect(response.body.filename).toBe('newfile.jpg');
      expect(mockStoreService.upload).toHaveBeenCalled();
      expect(mockArtifactRepository.update).toHaveBeenCalled();
    });

    it('should return 404 when artifact not found', async () => {
      const token = generateToken(testAccountId);
      mockArtifactRepository.findBy.mockResolvedValue(success(null));
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));

      await request(app.getHttpServer())
        .put('/artifacts/nonexistent')
        .set(authHeader(token))
        .send(updateDto)
        .expect(404);
    });

    it('should return 403 when user does not own artifact', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockArtifactRepository.findBy.mockResolvedValue(
        success(testArtifactRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));

      await request(app.getHttpServer())
        .put(`/artifacts/${testArtifactId}`)
        .set(authHeader(token))
        .send(updateDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .put(`/artifacts/${testArtifactId}`)
        .send(updateDto)
        .expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .put(`/artifacts/${testArtifactId}`)
        .set(authHeader('invalid-token'))
        .send(updateDto)
        .expect(401);
    });
  });

  describe('DELETE /artifacts/:artifactId', () => {
    it('should return 204 and delete artifact with file (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockArtifactRepository.findBy.mockResolvedValue(
        success(testArtifactRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockStoreService.delete.mockResolvedValue(undefined);
      mockArtifactRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/artifacts/${testArtifactId}`)
        .set(authHeader(token))
        .expect(204);

      expect(mockStoreService.delete).toHaveBeenCalled();
      expect(mockArtifactRepository.delete).toHaveBeenCalledWith(
        testArtifactId,
      );
    });

    it('should return 204 even if storage deletion fails', async () => {
      const token = generateToken(testAccountId);

      mockArtifactRepository.findBy.mockResolvedValue(
        success(testArtifactRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockStoreService.delete.mockRejectedValue(new Error('Storage error'));
      mockArtifactRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/artifacts/${testArtifactId}`)
        .set(authHeader(token))
        .expect(204);

      expect(mockArtifactRepository.delete).toHaveBeenCalled();
    });

    it('should return 404 when artifact not found', async () => {
      const token = generateToken(testAccountId);
      mockArtifactRepository.findBy.mockResolvedValue(success(null));
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));

      await request(app.getHttpServer())
        .delete('/artifacts/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 403 when user does not own artifact', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockArtifactRepository.findBy.mockResolvedValue(
        success(testArtifactRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));

      await request(app.getHttpServer())
        .delete(`/artifacts/${testArtifactId}`)
        .set(authHeader(token))
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .delete(`/artifacts/${testArtifactId}`)
        .expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .delete(`/artifacts/${testArtifactId}`)
        .set(authHeader('invalid-token'))
        .expect(401);
    });
  });

  describe('Edge Cases', () => {
    it('should handle large file size validation', async () => {
      const token = generateToken(testAccountId);

      mockArtifactRepository.findBy.mockResolvedValue(
        success(testArtifactRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));

      // Create a buffer larger than MAX_ARTIFACT_SIZE (50MB)
      const largeBuffer = Buffer.alloc(51 * 1024 * 1024);

      await request(app.getHttpServer())
        .put(`/artifacts/${testArtifactId}`)
        .set(authHeader(token))
        .field('type', 'document')
        .attach('file', largeBuffer, 'large.jpg')
        .expect(400);
    });

    it('should handle missing author gracefully', async () => {
      const token = generateToken(testAccountId);

      mockArtifactRepository.findBy.mockResolvedValue(
        success(testArtifactRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .put(`/artifacts/${testArtifactId}`)
        .set(authHeader(token))
        .send({ type: 'document' })
        .expect(404);
    });

    it('should handle storage upload failure', async () => {
      const token = generateToken(testAccountId);

      mockArtifactRepository.findBy.mockResolvedValue(
        success(testArtifactRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockStoreService.upload.mockRejectedValue(new Error('Upload failed'));

      await request(app.getHttpServer())
        .put(`/artifacts/${testArtifactId}`)
        .set(authHeader(token))
        .field('type', 'document')
        .attach('file', Buffer.from('test'), 'test.jpg')
        .expect(500);
    });

    it('should handle database update failure', async () => {
      const token = generateToken(testAccountId);

      mockArtifactRepository.findBy.mockResolvedValue(
        success(testArtifactRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockArtifactRepository.update.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await request(app.getHttpServer())
        .put(`/artifacts/${testArtifactId}`)
        .set(authHeader(token))
        .send({ type: 'document' })
        .expect(500);
    });

    it('should handle database delete failure', async () => {
      const token = generateToken(testAccountId);

      mockArtifactRepository.findBy.mockResolvedValue(
        success(testArtifactRaw),
      );
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockStoreService.delete.mockResolvedValue(undefined);
      mockArtifactRepository.delete.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await request(app.getHttpServer())
        .delete(`/artifacts/${testArtifactId}`)
        .set(authHeader(token))
        .expect(500);
    });
  });
});
