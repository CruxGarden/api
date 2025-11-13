import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { ThemeRepository } from '../src/theme/theme.repository';
import { AuthorRepository } from '../src/author/author.repository';
import { TagService } from '../src/tag/tag.service';
import { HomeService } from '../src/home/home.service';
import { DbService } from '../src/common/services/db.service';
import { MockDbService } from './mocks/db.mock';
import { success } from '../src/common/helpers/repository-helpers';
import ThemeRaw from '../src/theme/entities/theme-raw.entity';
import AuthorRaw from '../src/author/entities/author-raw.entity';
import TagRaw from '../src/tag/entities/tag-raw.entity';
import { ResourceType } from '../src/common/types/enums';

describe('Theme Integration Tests', () => {
  let app: INestApplication;
  let mockThemeRepository: jest.Mocked<ThemeRepository>;
  let mockAuthorRepository: jest.Mocked<AuthorRepository>;
  let mockTagService: jest.Mocked<TagService>;

  const testAccountId = 'account-123';
  const testAuthorId = 'author-123';
  const testThemeId = 'theme-123';
  const testThemeKey = 'theme-key';

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

  const testThemeRaw: ThemeRaw = {
    id: testThemeId,
    key: testThemeKey,
    title: 'Ocean Blue',
    description: 'A blue theme',
    type: 'nature',
    kind: 'light',
    system: false,
    meta: {
      palette: {
        light: {
          primary: '#2563eb',
          secondary: '#3b82f6',
          tertiary: '#60a5fa',
          quaternary: '#93c5fd',
        },
      },
    },
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
    mockThemeRepository = {
      findAllQuery: jest.fn(),
      findBy: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as any;

    mockAuthorRepository = {
      findBy: jest.fn(),
    } as any;

    mockTagService = {
      getTags: jest.fn(),
      syncTags: jest.fn(),
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
      .overrideProvider(ThemeRepository)
      .useValue(mockThemeRepository)
      .overrideProvider(AuthorRepository)
      .useValue(mockAuthorRepository)
      .overrideProvider(TagService)
      .useValue(mockTagService)
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

  describe('GET /themes', () => {
    it('should return 200 and list of themes (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockThemeRepository.findAllQuery.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
      } as any);

      const response = await request(app.getHttpServer())
        .get('/themes')
        .set(authHeader(token))
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(mockThemeRepository.findAllQuery).toHaveBeenCalled();
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer()).get('/themes').expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .get('/themes')
        .set(authHeader('invalid-token'))
        .expect(401);
    });
  });

  describe('GET /themes/:themeKey', () => {
    it('should return 200 and theme data (happy path)', async () => {
      const token = generateToken(testAccountId);
      mockThemeRepository.findBy.mockResolvedValue(success(testThemeRaw));

      const response = await request(app.getHttpServer())
        .get(`/themes/${testThemeKey}`)
        .set(authHeader(token))
        .expect(200);

      expect(response.body).toMatchObject({
        id: testThemeId,
        key: testThemeKey,
        title: 'Ocean Blue',
      });
      expect(mockThemeRepository.findBy).toHaveBeenCalledWith(
        'key',
        testThemeKey,
      );
    });

    it('should return 404 when theme not found', async () => {
      const token = generateToken(testAccountId);
      mockThemeRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .get('/themes/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .get(`/themes/${testThemeKey}`)
        .expect(401);
    });
  });

  describe('POST /themes', () => {
    const createThemeDto = {
      title: 'Sunset Orange',
      type: 'creative',
      kind: 'light',
      meta: {
        palette: {
          light: {
            primary: '#ff6b35',
            secondary: '#f7931e',
            tertiary: '#ffb700',
            quaternary: '#ffc857',
          },
        },
      },
    };

    it('should return 201 and create theme (happy path)', async () => {
      const token = generateToken(testAccountId);
      const newThemeRaw: ThemeRaw = {
        id: 'new-theme-id',
        key: 'new-theme-key',
        title: createThemeDto.title,
        type: createThemeDto.type,
        kind: createThemeDto.kind,
        system: false,
        meta: createThemeDto.meta,
        author_id: testAuthorId,
        home_id: 'home-123',
        created: new Date(),
        updated: new Date(),
        deleted: null,
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockThemeRepository.create.mockResolvedValue(success(newThemeRaw));

      const response = await request(app.getHttpServer())
        .post('/themes')
        .set(authHeader(token))
        .send(createThemeDto)
        .expect(201);

      expect(response.body).toMatchObject({
        title: 'Sunset Orange',
      });
      expect(mockThemeRepository.create).toHaveBeenCalled();
    });

    it('should return 400 when required fields missing', async () => {
      const token = generateToken(testAccountId);

      await request(app.getHttpServer())
        .post('/themes')
        .set(authHeader(token))
        .send({ type: 'nature' }) // Missing required 'title' field
        .expect(400);
    });

    it('should return 400 when invalid hex color in meta', async () => {
      const token = generateToken(testAccountId);

      await request(app.getHttpServer())
        .post('/themes')
        .set(authHeader(token))
        .send({
          title: 'Invalid Theme',
          meta: {
            palette: {
              light: { primary: 'not-a-hex-color' },
            },
          },
        })
        .expect(400);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .post('/themes')
        .send(createThemeDto)
        .expect(401);
    });

    it('should return 404 when author not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .post('/themes')
        .set(authHeader(token))
        .send(createThemeDto)
        .expect(404);
    });
  });

  describe('PATCH /themes/:themeKey', () => {
    const updateThemeDto = {
      title: 'Updated Ocean Blue',
      meta: {
        palette: {
          light: { primary: '#1e40af' },
        },
      },
    };

    it('should return 200 and update theme (happy path)', async () => {
      const token = generateToken(testAccountId);
      const updatedThemeRaw: ThemeRaw = {
        ...testThemeRaw,
        title: updateThemeDto.title,
        meta: { ...testThemeRaw.meta, ...updateThemeDto.meta },
        updated: new Date(),
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockThemeRepository.findBy.mockResolvedValue(success(testThemeRaw));
      mockThemeRepository.update.mockResolvedValue(success(updatedThemeRaw));

      const response = await request(app.getHttpServer())
        .patch(`/themes/${testThemeKey}`)
        .set(authHeader(token))
        .send(updateThemeDto)
        .expect(200);

      expect(response.body.title).toBe('Updated Ocean Blue');
      expect(mockThemeRepository.update).toHaveBeenCalled();
    });

    it('should return 404 when theme not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockThemeRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .patch('/themes/nonexistent')
        .set(authHeader(token))
        .send(updateThemeDto)
        .expect(404);
    });

    it('should return 403 when user does not own theme', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockThemeRepository.findBy.mockResolvedValue(success(testThemeRaw));

      await request(app.getHttpServer())
        .patch(`/themes/${testThemeKey}`)
        .set(authHeader(token))
        .send(updateThemeDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .patch(`/themes/${testThemeKey}`)
        .send(updateThemeDto)
        .expect(401);
    });
  });

  describe('DELETE /themes/:themeKey', () => {
    it('should return 204 and delete theme (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockThemeRepository.findBy.mockResolvedValue(success(testThemeRaw));
      mockThemeRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/themes/${testThemeKey}`)
        .set(authHeader(token))
        .expect(204);

      expect(mockThemeRepository.delete).toHaveBeenCalledWith(testThemeId);
    });

    it('should return 404 when theme not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockThemeRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete('/themes/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 403 when user does not own theme', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockThemeRepository.findBy.mockResolvedValue(success(testThemeRaw));

      await request(app.getHttpServer())
        .delete(`/themes/${testThemeKey}`)
        .set(authHeader(token))
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .delete(`/themes/${testThemeKey}`)
        .expect(401);
    });
  });

  describe('GET /themes/:themeKey/tags', () => {
    it('should return 200 and list of tags (happy path)', async () => {
      const token = generateToken(testAccountId);
      const testTagsRaw: TagRaw[] = [
        {
          id: 'tag-1',
          key: 'tagkey1',
          label: 'blue',
          resource_type: ResourceType.THEME,
          resource_id: testThemeId,
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
        .get(`/themes/${testThemeKey}/tags`)
        .set(authHeader(token))
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body[0]).toMatchObject({
        label: 'blue',
      });
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .get(`/themes/${testThemeKey}/tags`)
        .expect(401);
    });
  });

  describe('PUT /themes/:themeKey/tags', () => {
    const syncTagsDto = {
      labels: ['blue', 'ocean', 'calm'],
    };

    it('should return 200 and sync tags (happy path)', async () => {
      const token = generateToken(testAccountId);
      const syncedTagsRaw: TagRaw[] = syncTagsDto.labels.map((label, idx) => ({
        id: `tag-${idx}`,
        key: `tagkey${idx}`,
        label,
        resource_type: ResourceType.THEME,
        resource_id: testThemeId,
        author_id: testAuthorId,
        home_id: 'home-123',
        created: new Date(),
        updated: new Date(),
        deleted: null,
        system: false,
      }));

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockThemeRepository.findBy.mockResolvedValue(success(testThemeRaw));
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
        .put(`/themes/${testThemeKey}/tags`)
        .set(authHeader(token))
        .send(syncTagsDto)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(3);
    });

    it('should return 404 when theme not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockThemeRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .put('/themes/nonexistent/tags')
        .set(authHeader(token))
        .send(syncTagsDto)
        .expect(404);
    });

    it('should return 403 when user does not own theme', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockThemeRepository.findBy.mockResolvedValue(success(testThemeRaw));

      await request(app.getHttpServer())
        .put(`/themes/${testThemeKey}/tags`)
        .set(authHeader(token))
        .send(syncTagsDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .put(`/themes/${testThemeKey}/tags`)
        .send(syncTagsDto)
        .expect(401);
    });
  });
});
