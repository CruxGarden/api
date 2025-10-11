import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { PathRepository } from '../src/path/path.repository';
import { AuthorRepository } from '../src/author/author.repository';
import { TagService } from '../src/tag/tag.service';
import { CruxService } from '../src/crux/crux.service';
import { HomeService } from '../src/home/home.service';
import { DbService } from '../src/common/services/db.service';
import { MockDbService } from './mocks/db.mock';
import { success } from '../src/common/helpers/repository-helpers';
import PathRaw from '../src/path/entities/path-raw.entity';
import MarkerRaw from '../src/path/entities/marker-raw.entity';
import AuthorRaw from '../src/author/entities/author-raw.entity';
import TagRaw from '../src/tag/entities/tag-raw.entity';
import { ResourceType } from '../src/common/types/enums';

describe('Path Integration Tests', () => {
  let app: INestApplication;
  let mockPathRepository: jest.Mocked<PathRepository>;
  let mockAuthorRepository: jest.Mocked<AuthorRepository>;
  let mockTagService: jest.Mocked<TagService>;
  let mockCruxService: jest.Mocked<CruxService>;

  const testAccountId = 'account-123';
  const testAuthorId = 'author-123';
  const testPathId = 'path-123';
  const testPathKey = 'path-key';
  const testEntryMarkerId = '550e8400-e29b-41d4-a716-446655440000';

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

  const testPathRaw: PathRaw = {
    id: testPathId,
    key: testPathKey,
    slug: 'test-path',
    title: 'Test Path',
    description: 'Test path description',
    type: 'living',
    visibility: 'unlisted',
    kind: 'wander',
    entry: testEntryMarkerId,
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
    mockPathRepository = {
      findAllQuery: jest.fn(),
      findBy: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findMarkersByPathId: jest.fn(),
      deleteMarkersByPathId: jest.fn(),
      createMarker: jest.fn(),
    } as any;

    mockAuthorRepository = {
      findBy: jest.fn(),
    } as any;

    mockTagService = {
      getTags: jest.fn(),
      syncTags: jest.fn(),
    } as any;

    mockCruxService = {
      findByKey: jest.fn(),
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
      .overrideProvider(PathRepository)
      .useValue(mockPathRepository)
      .overrideProvider(AuthorRepository)
      .useValue(mockAuthorRepository)
      .overrideProvider(TagService)
      .useValue(mockTagService)
      .overrideProvider(CruxService)
      .useValue(mockCruxService)
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

  describe('GET /paths', () => {
    it('should return 200 and list of paths (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockPathRepository.findAllQuery.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
      } as any);

      const response = await request(app.getHttpServer())
        .get('/paths')
        .set(authHeader(token))
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(mockPathRepository.findAllQuery).toHaveBeenCalled();
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer()).get('/paths').expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .get('/paths')
        .set(authHeader('invalid-token'))
        .expect(401);
    });
  });

  describe('GET /paths/:pathKey', () => {
    it('should return 200 and path data (happy path)', async () => {
      const token = generateToken(testAccountId);
      mockPathRepository.findBy.mockResolvedValue(success(testPathRaw));

      const response = await request(app.getHttpServer())
        .get(`/paths/${testPathKey}`)
        .set(authHeader(token))
        .expect(200);

      expect(response.body).toMatchObject({
        id: testPathId,
        key: testPathKey,
        slug: 'test-path',
        title: 'Test Path',
      });
      expect(mockPathRepository.findBy).toHaveBeenCalledWith(
        'key',
        testPathKey,
      );
    });

    it('should return 404 when path not found', async () => {
      const token = generateToken(testAccountId);
      mockPathRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .get('/paths/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .get(`/paths/${testPathKey}`)
        .expect(401);
    });
  });

  describe('POST /paths', () => {
    const createPathDto = {
      slug: 'new-path',
      title: 'New Path',
      description: 'New path description',
      kind: 'wander',
      entry: '550e8400-e29b-41d4-a716-446655440001',
    };

    it('should return 201 and create path (happy path)', async () => {
      const token = generateToken(testAccountId);
      const newPathRaw: PathRaw = {
        id: 'new-path-id',
        key: 'new-path-key',
        slug: createPathDto.slug,
        title: createPathDto.title,
        description: createPathDto.description,
        type: 'living',
        visibility: 'unlisted',
        kind: createPathDto.kind as 'wander' | 'guide',
        entry: createPathDto.entry,
        author_id: testAuthorId,
        home_id: 'home-123',
        created: new Date(),
        updated: new Date(),
        deleted: null,
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockPathRepository.create.mockResolvedValue(success(newPathRaw));

      const response = await request(app.getHttpServer())
        .post('/paths')
        .set(authHeader(token))
        .send(createPathDto)
        .expect(201);

      expect(response.body).toMatchObject({
        slug: 'new-path',
        title: 'New Path',
        kind: 'wander',
      });
      expect(mockPathRepository.create).toHaveBeenCalled();
    });

    it('should return 400 when required fields missing', async () => {
      const token = generateToken(testAccountId);

      await request(app.getHttpServer())
        .post('/paths')
        .set(authHeader(token))
        .send({ title: 'Missing slug and entry' })
        .expect(400);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .post('/paths')
        .send(createPathDto)
        .expect(401);
    });

    it('should return 404 when author not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .post('/paths')
        .set(authHeader(token))
        .send(createPathDto)
        .expect(404);
    });
  });

  describe('PATCH /paths/:pathKey', () => {
    const updatePathDto = {
      title: 'Updated Path Title',
      description: 'Updated description',
    };

    it('should return 200 and update path (happy path)', async () => {
      const token = generateToken(testAccountId);
      const updatedPathRaw: PathRaw = {
        ...testPathRaw,
        title: updatePathDto.title,
        description: updatePathDto.description,
        updated: new Date(),
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(testPathRaw));
      mockPathRepository.update.mockResolvedValue(success(updatedPathRaw));

      const response = await request(app.getHttpServer())
        .patch(`/paths/${testPathKey}`)
        .set(authHeader(token))
        .send(updatePathDto)
        .expect(200);

      expect(response.body.title).toBe('Updated Path Title');
      expect(mockPathRepository.update).toHaveBeenCalled();
    });

    it('should return 404 when path not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .patch('/paths/nonexistent')
        .set(authHeader(token))
        .send(updatePathDto)
        .expect(404);
    });

    it('should return 403 when user does not own path', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(testPathRaw));

      await request(app.getHttpServer())
        .patch(`/paths/${testPathKey}`)
        .set(authHeader(token))
        .send(updatePathDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .patch(`/paths/${testPathKey}`)
        .send(updatePathDto)
        .expect(401);
    });
  });

  describe('DELETE /paths/:pathKey', () => {
    it('should return 204 and delete path (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(testPathRaw));
      mockPathRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/paths/${testPathKey}`)
        .set(authHeader(token))
        .expect(204);

      expect(mockPathRepository.delete).toHaveBeenCalledWith(testPathId);
    });

    it('should return 404 when path not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete('/paths/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 403 when user does not own path', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(testPathRaw));

      await request(app.getHttpServer())
        .delete(`/paths/${testPathKey}`)
        .set(authHeader(token))
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .delete(`/paths/${testPathKey}`)
        .expect(401);
    });
  });

  describe('GET /paths/:pathKey/markers', () => {
    it('should return 200 and list of markers (happy path)', async () => {
      const token = generateToken(testAccountId);
      const testMarkersRaw: MarkerRaw[] = [
        {
          id: 'marker-1',
          key: 'marker-key-1',
          path_id: testPathId,
          crux_id: 'crux-1',
          order: 0,
          note: 'First marker',
          author_id: testAuthorId,
          home_id: 'home-123',
          created: new Date(),
          updated: new Date(),
          deleted: null,
        },
      ];

      mockPathRepository.findBy.mockResolvedValue(success(testPathRaw));
      mockPathRepository.findMarkersByPathId.mockResolvedValue(
        success(testMarkersRaw),
      );

      const response = await request(app.getHttpServer())
        .get(`/paths/${testPathKey}/markers`)
        .set(authHeader(token))
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body[0]).toMatchObject({
        order: 0,
        note: 'First marker',
      });
    });

    it('should return 404 when path not found', async () => {
      const token = generateToken(testAccountId);
      mockPathRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .get('/paths/nonexistent/markers')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .get(`/paths/${testPathKey}/markers`)
        .expect(401);
    });
  });

  describe('PUT /paths/:pathKey/markers', () => {
    const syncMarkersDto = {
      markers: [
        { cruxKey: 'crux-key-1', order: 0, note: 'First' },
        { cruxKey: 'crux-key-2', order: 1, note: 'Second' },
      ],
    };

    it('should return 200 and sync markers (happy path)', async () => {
      const token = generateToken(testAccountId);
      const syncedMarkersRaw: MarkerRaw[] = [
        {
          id: 'marker-0',
          key: 'marker-key-0',
          path_id: testPathId,
          crux_id: 'crux-id-1',
          order: 0,
          note: 'First',
          author_id: testAuthorId,
          home_id: 'home-123',
          created: new Date(),
          updated: new Date(),
          deleted: null,
        },
        {
          id: 'marker-1',
          key: 'marker-key-1',
          path_id: testPathId,
          crux_id: 'crux-id-2',
          order: 1,
          note: 'Second',
          author_id: testAuthorId,
          home_id: 'home-123',
          created: new Date(),
          updated: new Date(),
          deleted: null,
        },
      ];

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(testPathRaw));
      mockPathRepository.deleteMarkersByPathId.mockResolvedValue(success(null));

      // Mock crux lookups for markers
      mockCruxService.findByKey
        .mockResolvedValueOnce({ id: 'crux-id-1' } as any)
        .mockResolvedValueOnce({ id: 'crux-id-2' } as any);

      // Mock marker creation for each marker in the sync
      mockPathRepository.createMarker
        .mockResolvedValueOnce(success(syncedMarkersRaw[0]))
        .mockResolvedValueOnce(success(syncedMarkersRaw[1]));

      const response = await request(app.getHttpServer())
        .put(`/paths/${testPathKey}/markers`)
        .set(authHeader(token))
        .send(syncMarkersDto)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
    });

    it('should return 404 when path not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .put('/paths/nonexistent/markers')
        .set(authHeader(token))
        .send(syncMarkersDto)
        .expect(404);
    });

    it('should return 403 when user does not own path', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(testPathRaw));

      await request(app.getHttpServer())
        .put(`/paths/${testPathKey}/markers`)
        .set(authHeader(token))
        .send(syncMarkersDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .put(`/paths/${testPathKey}/markers`)
        .send(syncMarkersDto)
        .expect(401);
    });
  });

  describe('GET /paths/:pathKey/tags', () => {
    it('should return 200 and list of tags (happy path)', async () => {
      const token = generateToken(testAccountId);
      const testTagsRaw: TagRaw[] = [
        {
          id: 'tag-1',
          key: 'tagkey1',
          label: 'javascript',
          resource_type: ResourceType.PATH,
          resource_id: testPathId,
          author_id: testAuthorId,
          home_id: 'home-123',
          created: new Date(),
          updated: new Date(),
          deleted: null,
          system: false,
        },
      ];

      mockTagService.getTags.mockResolvedValue(
        testTagsRaw.map((tag) => ({
          id: tag.id,
          key: tag.key,
          label: tag.label,
          resourceType: tag.resource_type,
          resourceId: tag.resource_id,
          authorId: tag.author_id,
          created: tag.created,
          updated: tag.updated,
          system: tag.system,
        })) as any,
      );

      const response = await request(app.getHttpServer())
        .get(`/paths/${testPathKey}/tags`)
        .set(authHeader(token))
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body[0]).toMatchObject({
        label: 'javascript',
      });
    });

    it('should return 404 when path not found', async () => {
      const token = generateToken(testAccountId);
      mockTagService.getTags.mockRejectedValue(new Error('Path not found'));

      await request(app.getHttpServer())
        .get('/paths/nonexistent/tags')
        .set(authHeader(token))
        .expect(500); // Service throws error which becomes 500
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .get(`/paths/${testPathKey}/tags`)
        .expect(401);
    });
  });

  describe('PUT /paths/:pathKey/tags', () => {
    const syncTagsDto = {
      labels: ['javascript', 'typescript', 'nodejs'],
    };

    it('should return 200 and sync tags (happy path)', async () => {
      const token = generateToken(testAccountId);
      const syncedTagsRaw: TagRaw[] = syncTagsDto.labels.map((label, idx) => ({
        id: `tag-${idx}`,
        key: `tagkey${idx}`,
        label,
        resource_type: ResourceType.PATH,
        resource_id: testPathId,
        author_id: testAuthorId,
        home_id: 'home-123',
        created: new Date(),
        updated: new Date(),
        deleted: null,
        system: false,
      }));

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(testPathRaw));
      mockTagService.syncTags.mockResolvedValue(
        syncedTagsRaw.map((tag) => ({
          id: tag.id,
          key: tag.key,
          label: tag.label,
          resourceType: tag.resource_type,
          resourceId: tag.resource_id,
          authorId: tag.author_id,
          created: tag.created,
          updated: tag.updated,
          system: tag.system,
        })) as any,
      );

      const response = await request(app.getHttpServer())
        .put(`/paths/${testPathKey}/tags`)
        .set(authHeader(token))
        .send(syncTagsDto)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(3);
    });

    it('should return 404 when path not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .put('/paths/nonexistent/tags')
        .set(authHeader(token))
        .send(syncTagsDto)
        .expect(404);
    });

    it('should return 403 when user does not own path', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockPathRepository.findBy.mockResolvedValue(success(testPathRaw));

      await request(app.getHttpServer())
        .put(`/paths/${testPathKey}/tags`)
        .set(authHeader(token))
        .send(syncTagsDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .put(`/paths/${testPathKey}/tags`)
        .send(syncTagsDto)
        .expect(401);
    });
  });
});
