import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { TagRepository } from '../src/tag/tag.repository';
import { HomeService } from '../src/home/home.service';
import { DbService } from '../src/common/services/db.service';
import { MockDbService } from './mocks/db.mock';
import { success } from '../src/common/helpers/repository-helpers';
import TagRaw from '../src/tag/entities/tag-raw.entity';
import { ResourceType } from '../src/common/types/enums';

describe('Tag Integration Tests', () => {
  let app: INestApplication;
  let mockTagRepository: jest.Mocked<TagRepository>;

  const testAccountId = 'account-123';
  const testAdminAccountId = 'admin-account-123';
  const testAuthorId = 'author-123';
  const testTagId = 'tag-123';
  const testTagKey = 'tag-key';
  const testResourceId = 'resource-123';

  const testTagRaw: TagRaw = {
    id: testTagId,
    key: testTagKey,
    resource_type: ResourceType.CRUX,
    resource_id: testResourceId,
    label: 'javascript',
    author_id: testAuthorId,
    home_id: 'home-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
    system: false,
  };

  const generateToken = (
    accountId: string,
    role: string = 'author',
  ): string => {
    return jwt.sign(
      { id: accountId, email: 'test@example.com', role },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '1h' },
    );
  };

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    // Create mock repository
    mockTagRepository = {
      findAllQuery: jest.fn(),
      findBy: jest.fn(),
      update: jest.fn(),
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
      .overrideProvider(TagRepository)
      .useValue(mockTagRepository)
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

  describe('GET /tags', () => {
    it('should return 200 and list of tags (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockTagRepository.findAllQuery.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereILike: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        count: jest.fn().mockReturnThis(),
      } as any);

      const response = await request(app.getHttpServer())
        .get('/tags')
        .set(authHeader(token))
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(mockTagRepository.findAllQuery).toHaveBeenCalled();
    });

    it('should return 200 with query parameters', async () => {
      const token = generateToken(testAccountId);

      mockTagRepository.findAllQuery.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereILike: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        count: jest.fn().mockReturnThis(),
      } as any);

      await request(app.getHttpServer())
        .get('/tags?resourceType=crux&search=java&sort=alpha')
        .set(authHeader(token))
        .expect(200);

      expect(mockTagRepository.findAllQuery).toHaveBeenCalledWith(
        'crux',
        'java',
        'alpha',
        undefined,
      );
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer()).get('/tags').expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .get('/tags')
        .set(authHeader('invalid-token'))
        .expect(401);
    });
  });

  describe('GET /tags/:tagKey', () => {
    it('should return 200 and tag data (happy path)', async () => {
      const token = generateToken(testAccountId);
      mockTagRepository.findBy.mockResolvedValue(success(testTagRaw));

      const response = await request(app.getHttpServer())
        .get(`/tags/${testTagKey}`)
        .set(authHeader(token))
        .expect(200);

      expect(response.body).toMatchObject({
        id: testTagId,
        key: testTagKey,
        label: 'javascript',
      });
      expect(mockTagRepository.findBy).toHaveBeenCalledWith('key', testTagKey);
    });

    it('should return 404 when tag not found', async () => {
      const token = generateToken(testAccountId);
      mockTagRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .get('/tags/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer()).get(`/tags/${testTagKey}`).expect(401);
    });
  });

  describe('PATCH /tags/:tagKey', () => {
    const updateTagDto = {
      label: 'typescript',
    };

    it('should return 200 and update tag (happy path - admin)', async () => {
      const token = generateToken(testAdminAccountId, 'admin');
      const updatedTagRaw: TagRaw = {
        ...testTagRaw,
        label: updateTagDto.label,
        updated: new Date(),
      };

      mockTagRepository.findBy.mockResolvedValue(success(testTagRaw));
      mockTagRepository.update.mockResolvedValue(success(updatedTagRaw));

      const response = await request(app.getHttpServer())
        .patch(`/tags/${testTagKey}`)
        .set(authHeader(token))
        .send(updateTagDto)
        .expect(200);

      expect(response.body.label).toBe('typescript');
      expect(mockTagRepository.update).toHaveBeenCalled();
    });

    it('should return 404 when tag not found', async () => {
      const token = generateToken(testAdminAccountId, 'admin');
      mockTagRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .patch('/tags/nonexistent')
        .set(authHeader(token))
        .send(updateTagDto)
        .expect(404);
    });

    it('should return 403 when user is not admin', async () => {
      const token = generateToken(testAccountId, 'author');

      await request(app.getHttpServer())
        .patch(`/tags/${testTagKey}`)
        .set(authHeader(token))
        .send(updateTagDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .patch(`/tags/${testTagKey}`)
        .send(updateTagDto)
        .expect(401);
    });

    it('should return 400 when invalid label format', async () => {
      const token = generateToken(testAdminAccountId, 'admin');

      await request(app.getHttpServer())
        .patch(`/tags/${testTagKey}`)
        .set(authHeader(token))
        .send({ label: 'INVALID LABEL' })
        .expect(400);
    });

    it('should return 400 when label contains uppercase', async () => {
      const token = generateToken(testAdminAccountId, 'admin');

      await request(app.getHttpServer())
        .patch(`/tags/${testTagKey}`)
        .set(authHeader(token))
        .send({ label: 'TypeScript' })
        .expect(400);
    });
  });

  describe('DELETE /tags/:tagKey', () => {
    it('should return 204 and delete tag (happy path - admin)', async () => {
      const token = generateToken(testAdminAccountId, 'admin');

      mockTagRepository.findBy.mockResolvedValue(success(testTagRaw));
      mockTagRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/tags/${testTagKey}`)
        .set(authHeader(token))
        .expect(204);

      expect(mockTagRepository.delete).toHaveBeenCalledWith(testTagId);
    });

    it('should return 404 when tag not found', async () => {
      const token = generateToken(testAdminAccountId, 'admin');
      mockTagRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete('/tags/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 403 when user is not admin', async () => {
      const token = generateToken(testAccountId, 'author');

      await request(app.getHttpServer())
        .delete(`/tags/${testTagKey}`)
        .set(authHeader(token))
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .delete(`/tags/${testTagKey}`)
        .expect(401);
    });
  });
});
