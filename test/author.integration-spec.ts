import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { AuthorRepository } from '../src/author/author.repository';
import { CruxRepository } from '../src/crux/crux.repository';
import { HomeService } from '../src/home/home.service';
import { DbService } from '../src/common/services/db.service';
import { MockDbService } from './mocks/db.mock';
import { success } from '../src/common/helpers/repository-helpers';
import AuthorRaw from '../src/author/entities/author-raw.entity';
import CruxRaw from '../src/crux/entities/crux-raw.entity';

describe('Author Integration Tests', () => {
  let app: INestApplication;
  let mockAuthorRepository: jest.Mocked<AuthorRepository>;
  let mockCruxRepository: jest.Mocked<CruxRepository>;

  const testAccountId = 'account-123';
  const testAuthorId = 'author-123';
  const testAuthorKey = 'author-key';
  const testUsername = 'testuser';
  const testHomeCruxId = 'home-crux-123';

  const testAuthorRaw: AuthorRaw = {
    id: testAuthorId,
    key: testAuthorKey,
    username: testUsername,
    display_name: 'Test User',
    account_id: testAccountId,
    bio: 'Test bio',
    home_id: testHomeCruxId,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const testHomeCruxRaw: CruxRaw = {
    id: testHomeCruxId,
    key: 'home-crux-key',
    slug: 'home',
    title: 'Home Crux',
    data: 'Home content',
    type: 'text',
    status: 'living',
    visibility: 'public',
    author_id: testAuthorId,
    home_id: testHomeCruxId,
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
    mockAuthorRepository = {
      findAllQuery: jest.fn(),
      findBy: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as any;

    mockCruxRepository = {
      findBy: jest.fn(),
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
      .overrideProvider(AuthorRepository)
      .useValue(mockAuthorRepository)
      .overrideProvider(CruxRepository)
      .useValue(mockCruxRepository)
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

  describe('GET /authors', () => {
    it('should return 200 and list of authors (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockAuthorRepository.findAllQuery.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
      } as any);

      const response = await request(app.getHttpServer())
        .get('/authors')
        .set(authHeader(token))
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(mockAuthorRepository.findAllQuery).toHaveBeenCalled();
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer()).get('/authors').expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .get('/authors')
        .set(authHeader('invalid-token'))
        .expect(401);
    });
  });

  describe('GET /authors/:identifier', () => {
    it('should return 200 and author data by key (happy path)', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));

      const response = await request(app.getHttpServer())
        .get(`/authors/${testAuthorKey}`)
        .set(authHeader(token))
        .expect(200);

      expect(response.body).toMatchObject({
        id: testAuthorId,
        key: testAuthorKey,
        username: testUsername,
        displayName: 'Test User',
      });
      expect(mockAuthorRepository.findBy).toHaveBeenCalledWith(
        'key',
        testAuthorKey,
      );
    });

    it('should return 200 and author data by username with @prefix', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));

      const response = await request(app.getHttpServer())
        .get(`/authors/@${testUsername}`)
        .set(authHeader(token))
        .expect(200);

      expect(response.body).toMatchObject({
        username: testUsername,
      });
      expect(mockAuthorRepository.findBy).toHaveBeenCalledWith(
        'username',
        testUsername,
      );
    });

    it('should return 200 with embedded home crux when embed=home', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockCruxRepository.findBy.mockResolvedValue(success(testHomeCruxRaw));

      const response = await request(app.getHttpServer())
        .get(`/authors/${testAuthorKey}?embed=home`)
        .set(authHeader(token))
        .expect(200);

      expect(response.body).toHaveProperty('home');
      expect(response.body.home).toMatchObject({
        id: testHomeCruxId,
        title: 'Home Crux',
      });
      expect(mockCruxRepository.findBy).toHaveBeenCalledWith(
        'id',
        testHomeCruxId,
      );
    });

    it('should return 404 when author not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .get('/authors/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .get(`/authors/${testAuthorKey}`)
        .expect(401);
    });
  });

  describe('POST /authors', () => {
    const createAuthorDto = {
      username: 'newuser',
      displayName: 'New User',
      bio: 'New user bio',
    };

    it('should return 201 and create author (happy path)', async () => {
      const token = generateToken(testAccountId);
      const newAuthorRaw: AuthorRaw = {
        id: 'new-author-id',
        key: 'new-author-key',
        username: createAuthorDto.username,
        display_name: createAuthorDto.displayName,
        account_id: testAccountId,
        bio: createAuthorDto.bio,
        home_id: 'home-123',
        created: new Date(),
        updated: new Date(),
        deleted: null,
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(null)); // No existing username
      mockAuthorRepository.create.mockResolvedValue(success(newAuthorRaw));

      const response = await request(app.getHttpServer())
        .post('/authors')
        .set(authHeader(token))
        .send(createAuthorDto)
        .expect(201);

      expect(response.body).toMatchObject({
        username: 'newuser',
        displayName: 'New User',
        bio: 'New user bio',
      });
      expect(mockAuthorRepository.create).toHaveBeenCalled();
    });

    it('should return 400 when required fields missing', async () => {
      const token = generateToken(testAccountId);

      await request(app.getHttpServer())
        .post('/authors')
        .set(authHeader(token))
        .send({ username: 'incomplete' })
        .expect(400);
    });

    it('should return 400 when extra fields provided', async () => {
      const token = generateToken(testAccountId);

      await request(app.getHttpServer())
        .post('/authors')
        .set(authHeader(token))
        .send({
          ...createAuthorDto,
          extraField: 'should be rejected',
        })
        .expect(400);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .post('/authors')
        .send(createAuthorDto)
        .expect(401);
    });

    it('should return 409 when username already exists', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw)); // Username exists

      await request(app.getHttpServer())
        .post('/authors')
        .set(authHeader(token))
        .send({
          username: testUsername,
          displayName: 'Duplicate Username',
        })
        .expect(409);
    });
  });

  describe('PATCH /authors/:authorKey', () => {
    const updateAuthorDto = {
      displayName: 'Updated Name',
      bio: 'Updated bio',
    };

    it('should return 200 and update author (happy path)', async () => {
      const token = generateToken(testAccountId);
      const updatedAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        display_name: updateAuthorDto.displayName,
        bio: updateAuthorDto.bio,
        updated: new Date(),
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockAuthorRepository.update.mockResolvedValue(success(updatedAuthorRaw));

      const response = await request(app.getHttpServer())
        .patch(`/authors/${testAuthorKey}`)
        .set(authHeader(token))
        .send(updateAuthorDto)
        .expect(200);

      expect(response.body.displayName).toBe('Updated Name');
      expect(response.body.bio).toBe('Updated bio');
      expect(mockAuthorRepository.update).toHaveBeenCalled();
    });

    it('should return 404 when author not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .patch('/authors/nonexistent')
        .set(authHeader(token))
        .send(updateAuthorDto)
        .expect(404);
    });

    it('should return 403 when user does not own author', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        account_id: 'other-account-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));

      await request(app.getHttpServer())
        .patch(`/authors/${testAuthorKey}`)
        .set(authHeader(token))
        .send(updateAuthorDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .patch(`/authors/${testAuthorKey}`)
        .send(updateAuthorDto)
        .expect(401);
    });
  });

  describe('DELETE /authors/:authorKey', () => {
    it('should return 204 and delete author (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockAuthorRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/authors/${testAuthorKey}`)
        .set(authHeader(token))
        .expect(204);

      expect(mockAuthorRepository.delete).toHaveBeenCalledWith(testAuthorId);
    });

    it('should return 404 when author not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete('/authors/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 403 when user does not own author', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        account_id: 'other-account-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));

      await request(app.getHttpServer())
        .delete(`/authors/${testAuthorKey}`)
        .set(authHeader(token))
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .delete(`/authors/${testAuthorKey}`)
        .expect(401);
    });
  });
});
