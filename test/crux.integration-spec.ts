import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { CruxRepository } from '../src/crux/crux.repository';
import { AuthorRepository } from '../src/author/author.repository';
import { DimensionRepository } from '../src/dimension/dimension.repository';
import { TagRepository } from '../src/tag/tag.repository';
import { HomeService } from '../src/home/home.service';
import { DbService } from '../src/common/services/db.service';
import { RedisService } from '../src/common/services/redis.service';
import { MockDbService } from './mocks/db.mock';
import { MockRedisService } from './mocks/redis.mock';
import { success } from '../src/common/helpers/repository-helpers';
import CruxRaw from '../src/crux/entities/crux-raw.entity';
import AuthorRaw from '../src/author/entities/author-raw.entity';
import DimensionRaw from '../src/dimension/entities/dimension-raw.entity';
import TagRaw from '../src/tag/entities/tag-raw.entity';
import { ResourceType } from '../src/common/types/enums';

describe('Crux Integration Tests', () => {
  let app: INestApplication;
  let mockCruxRepository: jest.Mocked<CruxRepository>;
  let mockAuthorRepository: jest.Mocked<AuthorRepository>;
  let mockDimensionRepository: jest.Mocked<DimensionRepository>;
  let mockTagRepository: jest.Mocked<TagRepository>;

  const testAccountId = 'account-123';
  const testAuthorId = 'author-123';
  const testCruxId = 'crux-123';
  const testCruxKey = 'abc123def';

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

  const testCruxRaw: CruxRaw = {
    id: testCruxId,
    key: testCruxKey,
    slug: 'test-crux',
    title: 'Test Crux',
    data: 'Test crux content',
    type: 'text',
    status: 'living',
    visibility: 'unlisted',
    author_id: testAuthorId,
    home_id: 'home-123',
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
    mockCruxRepository = {
      findAll: jest.fn(),
      findAllQuery: jest.fn(),
      findBy: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as any;

    mockAuthorRepository = {
      findBy: jest.fn(),
      create: jest.fn(),
    } as any;

    mockDimensionRepository = {
      findBy: jest.fn(),
      findBySourceIdAndTypeQuery: jest.fn(),
      create: jest.fn(),
    } as any;

    mockTagRepository = {
      findBy: jest.fn(),
      findAllQuery: jest.fn(),
      delete: jest.fn(),
      findByResource: jest.fn(),
      deleteByResource: jest.fn(),
      createMany: jest.fn(),
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
      .overrideProvider(RedisService)
      .useValue(new MockRedisService())
      .overrideProvider(CruxRepository)
      .useValue(mockCruxRepository)
      .overrideProvider(AuthorRepository)
      .useValue(mockAuthorRepository)
      .overrideProvider(DimensionRepository)
      .useValue(mockDimensionRepository)
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

  describe('GET /cruxes', () => {
    it('should return 200 and list of cruxes (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockCruxRepository.findAllQuery.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
      } as any);

      const response = await request(app.getHttpServer())
        .get('/cruxes')
        .set(authHeader(token))
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(mockCruxRepository.findAllQuery).toHaveBeenCalled();
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer()).get('/cruxes').expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .get('/cruxes')
        .set(authHeader('invalid-token'))
        .expect(401);
    });
  });

  describe('GET /cruxes/:cruxKey', () => {
    it('should return 200 and crux data (happy path)', async () => {
      const token = generateToken(testAccountId);
      mockCruxRepository.findBy.mockResolvedValue(success(testCruxRaw));

      const response = await request(app.getHttpServer())
        .get(`/cruxes/${testCruxKey}`)
        .set(authHeader(token))
        .expect(200);

      expect(response.body).toMatchObject({
        id: testCruxId,
        key: testCruxKey,
        slug: 'test-crux',
        title: 'Test Crux',
      });
      expect(mockCruxRepository.findBy).toHaveBeenCalledWith(
        'key',
        testCruxKey,
      );
    });

    it('should return 404 when crux not found', async () => {
      const token = generateToken(testAccountId);
      mockCruxRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .get('/cruxes/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .get(`/cruxes/${testCruxKey}`)
        .expect(401);
    });
  });

  describe('POST /cruxes', () => {
    const createCruxDto = {
      slug: 'new-crux',
      title: 'New Crux',
      data: 'New crux content',
      type: 'text',
      status: 'living',
      visibility: 'unlisted',
    };

    it('should return 201 and create crux (happy path)', async () => {
      const token = generateToken(testAccountId);
      const newCruxRaw: CruxRaw = {
        id: 'new-crux-id',
        key: 'newkey123',
        slug: createCruxDto.slug,
        title: createCruxDto.title,
        data: createCruxDto.data,
        type: createCruxDto.type,
        status: createCruxDto.status as 'living' | 'frozen',
        visibility: createCruxDto.visibility as
          | 'public'
          | 'private'
          | 'unlisted',
        author_id: testAuthorId,
        home_id: 'home-123',
        created: new Date(),
        updated: new Date(),
        deleted: null,
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockCruxRepository.create.mockResolvedValue(success(newCruxRaw));

      const response = await request(app.getHttpServer())
        .post('/cruxes')
        .set(authHeader(token))
        .send(createCruxDto)
        .expect(201);

      expect(response.body).toMatchObject({
        slug: 'new-crux',
        title: 'New Crux',
        data: 'New crux content',
      });
      expect(mockCruxRepository.create).toHaveBeenCalled();
    });

    it('should return 400 when required fields missing', async () => {
      const token = generateToken(testAccountId);

      await request(app.getHttpServer())
        .post('/cruxes')
        .set(authHeader(token))
        .send({ title: 'Missing slug and data' })
        .expect(400);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .post('/cruxes')
        .send(createCruxDto)
        .expect(401);
    });

    it('should return 404 when author not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .post('/cruxes')
        .set(authHeader(token))
        .send(createCruxDto)
        .expect(404);
    });
  });

  describe('PATCH /cruxes/:cruxKey', () => {
    const updateCruxDto = {
      title: 'Updated Crux Title',
      data: 'Updated content',
    };

    it('should return 200 and update crux (happy path)', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(testCruxRaw));
      mockCruxRepository.update.mockResolvedValue(
        success({ ...testCruxRaw, ...updateCruxDto }),
      );

      const response = await request(app.getHttpServer())
        .patch(`/cruxes/${testCruxKey}`)
        .set(authHeader(token))
        .send(updateCruxDto)
        .expect(200);

      expect(response.body.title).toBe('Updated Crux Title');
      expect(mockCruxRepository.update).toHaveBeenCalledWith(
        testCruxId,
        expect.objectContaining(updateCruxDto),
      );
    });

    it('should return 404 when crux not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .patch('/cruxes/nonexistent')
        .set(authHeader(token))
        .send(updateCruxDto)
        .expect(404);
    });

    it('should return 403 when user does not own crux', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(testCruxRaw));

      await request(app.getHttpServer())
        .patch(`/cruxes/${testCruxKey}`)
        .set(authHeader(token))
        .send(updateCruxDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .patch(`/cruxes/${testCruxKey}`)
        .send(updateCruxDto)
        .expect(401);
    });
  });

  describe('DELETE /cruxes/:cruxKey', () => {
    it('should return 204 and delete crux (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(testCruxRaw));
      mockCruxRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/cruxes/${testCruxKey}`)
        .set(authHeader(token))
        .expect(204);

      expect(mockCruxRepository.delete).toHaveBeenCalledWith(testCruxId);
    });

    it('should return 404 when crux not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete('/cruxes/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 403 when user does not own crux', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(testCruxRaw));

      await request(app.getHttpServer())
        .delete(`/cruxes/${testCruxKey}`)
        .set(authHeader(token))
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .delete(`/cruxes/${testCruxKey}`)
        .expect(401);
    });
  });

  describe('GET /cruxes/:cruxKey/dimensions', () => {
    it('should return 200 and list of dimensions (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockCruxRepository.findBy.mockResolvedValue(success(testCruxRaw));
      mockDimensionRepository.findBySourceIdAndTypeQuery.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
      } as any);

      const response = await request(app.getHttpServer())
        .get(`/cruxes/${testCruxKey}/dimensions`)
        .set(authHeader(token))
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(mockCruxRepository.findBy).toHaveBeenCalledWith(
        'key',
        testCruxKey,
      );
    });

    it('should return 200 with type filter', async () => {
      const token = generateToken(testAccountId);

      mockCruxRepository.findBy.mockResolvedValue(success(testCruxRaw));
      mockDimensionRepository.findBySourceIdAndTypeQuery.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
      } as any);

      await request(app.getHttpServer())
        .get(`/cruxes/${testCruxKey}/dimensions?type=gate`)
        .set(authHeader(token))
        .expect(200);
    });

    it('should return 404 when crux not found', async () => {
      const token = generateToken(testAccountId);
      mockCruxRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .get('/cruxes/nonexistent/dimensions')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .get(`/cruxes/${testCruxKey}/dimensions`)
        .expect(401);
    });
  });

  describe('POST /cruxes/:cruxKey/dimensions', () => {
    const targetCruxId = '550e8400-e29b-41d4-a716-446655440001';
    const createDimensionDto = {
      targetId: targetCruxId,
      type: 'gate',
      weight: 1,
    };

    it('should return 201 and create dimension (happy path)', async () => {
      const token = generateToken(testAccountId);
      const newDimensionRaw: DimensionRaw = {
        id: 'dim-123',
        key: 'dimkey123',
        source_id: testCruxId,
        target_id: targetCruxId,
        type: 'gate',
        weight: 1,
        author_id: testAuthorId,
        home_id: 'home-123',
        created: new Date(),
        updated: new Date(),
        deleted: null,
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockCruxRepository.findBy
        .mockResolvedValueOnce(success(testCruxRaw))
        .mockResolvedValueOnce(
          success({ ...testCruxRaw, id: targetCruxId, key: 'target-crux-key' }),
        );
      mockDimensionRepository.create.mockResolvedValue(
        success(newDimensionRaw),
      );

      const response = await request(app.getHttpServer())
        .post(`/cruxes/${testCruxKey}/dimensions`)
        .set(authHeader(token))
        .send(createDimensionDto)
        .expect(201);

      expect(response.body).toMatchObject({
        type: 'gate',
        weight: 1,
      });
      expect(mockDimensionRepository.create).toHaveBeenCalled();
    });

    it('should return 404 when source crux not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .post('/cruxes/nonexistent/dimensions')
        .set(authHeader(token))
        .send(createDimensionDto)
        .expect(404);
    });

    it('should return 403 when user does not own source crux', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(testCruxRaw));

      await request(app.getHttpServer())
        .post(`/cruxes/${testCruxKey}/dimensions`)
        .set(authHeader(token))
        .send(createDimensionDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .post(`/cruxes/${testCruxKey}/dimensions`)
        .send(createDimensionDto)
        .expect(401);
    });
  });

  describe('GET /cruxes/:cruxKey/tags', () => {
    it('should return 200 and list of tags (happy path)', async () => {
      const token = generateToken(testAccountId);
      const testTagsRaw: TagRaw[] = [
        {
          id: 'tag-1',
          key: 'tagkey1',
          label: 'javascript',
          resource_type: ResourceType.CRUX,
          resource_id: testCruxId,
          author_id: testAuthorId,
          home_id: 'home-123',
          created: new Date(),
          updated: new Date(),
          deleted: null,
          system: false,
        },
      ];

      mockCruxRepository.findBy.mockResolvedValue(success(testCruxRaw));
      mockTagRepository.findByResource.mockResolvedValue(success(testTagsRaw));

      const response = await request(app.getHttpServer())
        .get(`/cruxes/${testCruxKey}/tags`)
        .set(authHeader(token))
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body[0]).toMatchObject({
        label: 'javascript',
      });
    });

    it('should return 404 when crux not found', async () => {
      const token = generateToken(testAccountId);
      mockCruxRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .get('/cruxes/nonexistent/tags')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .get(`/cruxes/${testCruxKey}/tags`)
        .expect(401);
    });
  });

  describe('PUT /cruxes/:cruxKey/tags', () => {
    const syncTagsDto = {
      labels: ['javascript', 'typescript', 'nodejs'],
    };

    it('should return 200 and sync tags (happy path)', async () => {
      const token = generateToken(testAccountId);
      const syncedTagsRaw: TagRaw[] = syncTagsDto.labels.map((label, idx) => ({
        id: `tag-${idx}`,
        key: `tagkey${idx}`,
        label,
        resource_type: ResourceType.CRUX,
        resource_id: testCruxId,
        author_id: testAuthorId,
        home_id: 'home-123',
        created: new Date(),
        updated: new Date(),
        deleted: null,
        system: false,
      }));

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(testCruxRaw));
      mockTagRepository.findByResource
        .mockResolvedValueOnce(success([])) // existing tags (empty initially)
        .mockResolvedValueOnce(success(syncedTagsRaw)); // final tags after sync
      mockTagRepository.createMany.mockResolvedValue(success(syncedTagsRaw));

      const response = await request(app.getHttpServer())
        .put(`/cruxes/${testCruxKey}/tags`)
        .set(authHeader(token))
        .send(syncTagsDto)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(3);
    });

    it('should return 404 when crux not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .put('/cruxes/nonexistent/tags')
        .set(authHeader(token))
        .send(syncTagsDto)
        .expect(404);
    });

    it('should return 403 when user does not own crux', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(testCruxRaw));

      await request(app.getHttpServer())
        .put(`/cruxes/${testCruxKey}/tags`)
        .set(authHeader(token))
        .send(syncTagsDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .put(`/cruxes/${testCruxKey}/tags`)
        .send(syncTagsDto)
        .expect(401);
    });
  });
});
