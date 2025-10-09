import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { DimensionRepository } from '../src/dimension/dimension.repository';
import { AuthorRepository } from '../src/author/author.repository';
import { DbService } from '../src/common/services/db.service';
import { MockDbService } from './mocks/db.mock';
import { success } from '../src/common/helpers/repository-helpers';
import DimensionRaw from '../src/dimension/entities/dimension-raw.entity';
import AuthorRaw from '../src/author/entities/author-raw.entity';

describe('Dimension Integration Tests', () => {
  let app: INestApplication;
  let mockDimensionRepository: jest.Mocked<DimensionRepository>;
  let mockAuthorRepository: jest.Mocked<AuthorRepository>;

  const testAccountId = 'account-123';
  const testAuthorId = 'author-123';
  const testDimensionId = 'dimension-123';
  const testDimensionKey = 'dim-key';
  const testSourceCruxId = 'source-crux-123';
  const testTargetCruxId = 'target-crux-123';

  const testAuthorRaw: AuthorRaw = {
    id: testAuthorId,
    key: 'author-key',
    username: 'testuser',
    display_name: 'Test User',
    account_id: testAccountId,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const testDimensionRaw: DimensionRaw = {
    id: testDimensionId,
    key: testDimensionKey,
    source_id: testSourceCruxId,
    target_id: testTargetCruxId,
    type: 'gate',
    weight: 1,
    author_id: testAuthorId,
    note: 'Test dimension note',
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
    mockDimensionRepository = {
      findBy: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as any;

    mockAuthorRepository = {
      findBy: jest.fn(),
    } as any;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DbService)
      .useValue(new MockDbService())
      .overrideProvider(DimensionRepository)
      .useValue(mockDimensionRepository)
      .overrideProvider(AuthorRepository)
      .useValue(mockAuthorRepository)
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

  describe('GET /dimensions/:dimensionKey', () => {
    it('should return 200 and dimension data (happy path)', async () => {
      const token = generateToken(testAccountId);
      mockDimensionRepository.findBy.mockResolvedValue(
        success(testDimensionRaw),
      );

      const response = await request(app.getHttpServer())
        .get(`/dimensions/${testDimensionKey}`)
        .set(authHeader(token))
        .expect(200);

      expect(response.body).toMatchObject({
        id: testDimensionId,
        key: testDimensionKey,
        type: 'gate',
        weight: 1,
      });
      expect(mockDimensionRepository.findBy).toHaveBeenCalledWith(
        'key',
        testDimensionKey,
      );
    });

    it('should return 404 when dimension not found', async () => {
      const token = generateToken(testAccountId);
      mockDimensionRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .get('/dimensions/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .get(`/dimensions/${testDimensionKey}`)
        .expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .get(`/dimensions/${testDimensionKey}`)
        .set(authHeader('invalid-token'))
        .expect(401);
    });
  });

  describe('PATCH /dimensions/:dimensionKey', () => {
    const updateDimensionDto = {
      type: 'garden',
      weight: 5,
      note: 'Updated note',
    };

    it('should return 200 and update dimension (happy path)', async () => {
      const token = generateToken(testAccountId);
      const updatedDimensionRaw: DimensionRaw = {
        ...testDimensionRaw,
        type: 'garden',
        weight: 5,
        note: 'Updated note',
        updated: new Date(),
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockDimensionRepository.findBy.mockResolvedValue(
        success(testDimensionRaw),
      );
      mockDimensionRepository.update.mockResolvedValue(
        success(updatedDimensionRaw),
      );

      const response = await request(app.getHttpServer())
        .patch(`/dimensions/${testDimensionKey}`)
        .set(authHeader(token))
        .send(updateDimensionDto)
        .expect(200);

      expect(response.body.type).toBe('garden');
      expect(response.body.weight).toBe(5);
      expect(response.body.note).toBe('Updated note');
      expect(mockDimensionRepository.update).toHaveBeenCalled();
    });

    it('should return 404 when dimension not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockDimensionRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .patch('/dimensions/nonexistent')
        .set(authHeader(token))
        .send(updateDimensionDto)
        .expect(404);
    });

    it('should return 403 when user does not own dimension', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockDimensionRepository.findBy.mockResolvedValue(
        success(testDimensionRaw),
      );

      await request(app.getHttpServer())
        .patch(`/dimensions/${testDimensionKey}`)
        .set(authHeader(token))
        .send(updateDimensionDto)
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .patch(`/dimensions/${testDimensionKey}`)
        .send(updateDimensionDto)
        .expect(401);
    });

    it('should return 404 when author not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .patch(`/dimensions/${testDimensionKey}`)
        .set(authHeader(token))
        .send(updateDimensionDto)
        .expect(404);
    });

    it('should return 400 when invalid type provided', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));

      await request(app.getHttpServer())
        .patch(`/dimensions/${testDimensionKey}`)
        .set(authHeader(token))
        .send({ type: 'invalid-type' })
        .expect(400);
    });

    it('should return 400 when negative weight provided', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));

      await request(app.getHttpServer())
        .patch(`/dimensions/${testDimensionKey}`)
        .set(authHeader(token))
        .send({ weight: -1 })
        .expect(400);
    });

    it('should return 400 when extra fields provided', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));

      await request(app.getHttpServer())
        .patch(`/dimensions/${testDimensionKey}`)
        .set(authHeader(token))
        .send({
          type: 'garden',
          extraField: 'should be rejected',
        })
        .expect(400);
    });
  });

  describe('DELETE /dimensions/:dimensionKey', () => {
    it('should return 204 and delete dimension (happy path)', async () => {
      const token = generateToken(testAccountId);

      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockDimensionRepository.findBy.mockResolvedValue(
        success(testDimensionRaw),
      );
      mockDimensionRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/dimensions/${testDimensionKey}`)
        .set(authHeader(token))
        .expect(204);

      expect(mockDimensionRepository.delete).toHaveBeenCalledWith(
        testDimensionId,
      );
    });

    it('should return 404 when dimension not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(testAuthorRaw));
      mockDimensionRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete('/dimensions/nonexistent')
        .set(authHeader(token))
        .expect(404);
    });

    it('should return 403 when user does not own dimension', async () => {
      const token = generateToken(testAccountId);
      const otherAuthorRaw: AuthorRaw = {
        ...testAuthorRaw,
        id: 'other-author-id',
      };

      mockAuthorRepository.findBy.mockResolvedValue(success(otherAuthorRaw));
      mockDimensionRepository.findBy.mockResolvedValue(
        success(testDimensionRaw),
      );

      await request(app.getHttpServer())
        .delete(`/dimensions/${testDimensionKey}`)
        .set(authHeader(token))
        .expect(403);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .delete(`/dimensions/${testDimensionKey}`)
        .expect(401);
    });

    it('should return 404 when author not found', async () => {
      const token = generateToken(testAccountId);
      mockAuthorRepository.findBy.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete(`/dimensions/${testDimensionKey}`)
        .set(authHeader(token))
        .expect(404);
    });
  });
});
