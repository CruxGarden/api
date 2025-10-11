import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { HomeRepository } from '../src/home/home.repository';
import { DbService } from '../src/common/services/db.service';
import { MockDbService } from './mocks/db.mock';
import { success } from '../src/common/helpers/repository-helpers';
import HomeRaw from '../src/home/entities/home-raw.entity';

describe('Home Integration Tests', () => {
  let app: INestApplication;
  let mockHomeRepository: jest.Mocked<HomeRepository>;

  const testAdminAccountId = 'admin-account-123';
  const testAuthorAccountId = 'author-account-123';
  const testHomeId = 'home-123';
  const testHomeKey = 'home-key';

  const testHomeRaw: HomeRaw = {
    id: testHomeId,
    key: testHomeKey,
    name: 'Primary Home',
    description: 'The main home for all entities',
    primary: true,
    type: 'personal',
    kind: 'standard',
    meta: null,
    created: new Date(),
    updated: new Date(),
    deleted: null,
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
    mockHomeRepository = {
      findAllQuery: jest.fn(),
      findBy: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as any;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DbService)
      .useValue(new MockDbService())
      .overrideProvider(HomeRepository)
      .useValue(mockHomeRepository)
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

  describe('GET /homes', () => {
    it('should return 200 and list of homes (happy path)', async () => {
      const token = generateToken(testAuthorAccountId);

      mockHomeRepository.findAllQuery.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
      } as any);

      const response = await request(app.getHttpServer())
        .get('/homes')
        .set(authHeader(token))
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(mockHomeRepository.findAllQuery).toHaveBeenCalled();
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer()).get('/homes').expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .get('/homes')
        .set(authHeader('invalid-token'))
        .expect(401);
    });
  });

  describe('GET /homes/:homeKey', () => {
    it('should return 200 and home data (happy path)', async () => {
      const token = generateToken(testAuthorAccountId);
      mockHomeRepository.findBy.mockResolvedValue(success(testHomeRaw));

      const response = await request(app.getHttpServer())
        .get(`/homes/${testHomeKey}`)
        .set(authHeader(token))
        .expect(200);

      expect(response.body).toMatchObject({
        id: testHomeId,
        key: testHomeKey,
        name: 'Primary Home',
        primary: true,
      });
      expect(mockHomeRepository.findBy).toHaveBeenCalledWith(
        'key',
        testHomeKey,
      );
    });

    it('should return 404 when home not found', async () => {
      const token = generateToken(testAuthorAccountId);
      mockHomeRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .get('/homes/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .get(`/homes/${testHomeKey}`)
        .expect(401);
    });
  });

  describe('POST /homes', () => {
    const createHomeDto = {
      name: 'Secondary Home',
      description: 'A secondary home for testing',
      type: 'work',
      kind: 'standard',
      primary: false,
    };

    it('should return 201 and create home when admin (happy path)', async () => {
      const token = generateToken(testAdminAccountId, 'admin');
      const newHomeRaw: HomeRaw = {
        id: 'new-home-id',
        key: 'new-home-key',
        name: createHomeDto.name,
        description: createHomeDto.description,
        primary: createHomeDto.primary,
        type: createHomeDto.type,
        kind: createHomeDto.kind,
        meta: null,
        created: new Date(),
        updated: new Date(),
        deleted: null,
      };

      mockHomeRepository.create.mockResolvedValue(success(newHomeRaw));

      const response = await request(app.getHttpServer())
        .post('/homes')
        .set(authHeader(token))
        .send(createHomeDto)
        .expect(201);

      expect(response.body).toMatchObject({
        name: 'Secondary Home',
        primary: false,
      });
      expect(mockHomeRepository.create).toHaveBeenCalled();
    });

    it('should return 400 when required fields missing', async () => {
      const token = generateToken(testAdminAccountId, 'admin');

      await request(app.getHttpServer())
        .post('/homes')
        .set(authHeader(token))
        .send({ name: 'Missing type and kind' })
        .expect(400);
    });

    it('should return 403 when non-admin user tries to create', async () => {
      const token = generateToken(testAuthorAccountId, 'author');

      await request(app.getHttpServer())
        .post('/homes')
        .set(authHeader(token))
        .send(createHomeDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .post('/homes')
        .send(createHomeDto)
        .expect(401);
    });
  });

  describe('PATCH /homes/:homeKey', () => {
    const updateHomeDto = {
      name: 'Updated Primary Home',
      description: 'Updated description',
    };

    it('should return 200 and update home when admin (happy path)', async () => {
      const token = generateToken(testAdminAccountId, 'admin');
      const updatedHomeRaw: HomeRaw = {
        ...testHomeRaw,
        name: updateHomeDto.name,
        description: updateHomeDto.description,
        updated: new Date(),
      };

      mockHomeRepository.findBy.mockResolvedValue(success(testHomeRaw));
      mockHomeRepository.update.mockResolvedValue(success(updatedHomeRaw));

      const response = await request(app.getHttpServer())
        .patch(`/homes/${testHomeKey}`)
        .set(authHeader(token))
        .send(updateHomeDto)
        .expect(200);

      expect(response.body.name).toBe('Updated Primary Home');
      expect(mockHomeRepository.update).toHaveBeenCalled();
    });

    it('should return 404 when home not found', async () => {
      const token = generateToken(testAdminAccountId, 'admin');
      mockHomeRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .patch('/homes/nonexistent')
        .set(authHeader(token))
        .send(updateHomeDto)
        .expect(404);
    });

    it('should return 403 when non-admin user tries to update', async () => {
      const token = generateToken(testAuthorAccountId, 'author');

      await request(app.getHttpServer())
        .patch(`/homes/${testHomeKey}`)
        .set(authHeader(token))
        .send(updateHomeDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .patch(`/homes/${testHomeKey}`)
        .send(updateHomeDto)
        .expect(401);
    });
  });

  describe('DELETE /homes/:homeKey', () => {
    it('should return 204 and delete home when admin (happy path)', async () => {
      const token = generateToken(testAdminAccountId, 'admin');

      mockHomeRepository.findBy.mockResolvedValue(success(testHomeRaw));
      mockHomeRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/homes/${testHomeKey}`)
        .set(authHeader(token))
        .expect(204);

      expect(mockHomeRepository.delete).toHaveBeenCalledWith(testHomeId);
    });

    it('should return 404 when home not found', async () => {
      const token = generateToken(testAdminAccountId, 'admin');
      mockHomeRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete('/homes/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 403 when non-admin user tries to delete', async () => {
      const token = generateToken(testAuthorAccountId, 'author');

      await request(app.getHttpServer())
        .delete(`/homes/${testHomeKey}`)
        .set(authHeader(token))
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .delete(`/homes/${testHomeKey}`)
        .expect(401);
    });
  });
});
