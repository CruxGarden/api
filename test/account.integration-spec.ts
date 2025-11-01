import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { AccountRepository } from '../src/account/account.repository';
import { AuthorRepository } from '../src/author/author.repository';
import { CruxRepository } from '../src/crux/crux.repository';
import { ThemeRepository } from '../src/theme/theme.repository';
import { HomeService } from '../src/home/home.service';
import { DbService } from '../src/common/services/db.service';
import { MockDbService } from './mocks/db.mock';
import { success } from '../src/common/helpers/repository-helpers';
import AccountRaw from '../src/account/entities/account-raw.entity';

describe('Account Integration Tests', () => {
  let app: INestApplication;
  let mockAccountRepository: jest.Mocked<AccountRepository>;
  let mockAuthorRepository: jest.Mocked<AuthorRepository>;
  let mockCruxRepository: jest.Mocked<CruxRepository>;
  let mockThemeRepository: jest.Mocked<ThemeRepository>;

  const testAccountId = 'account-123';
  const testEmail = 'test@example.com';

  const testAccountRaw: AccountRaw = {
    id: testAccountId,
    key: 'account-key',
    email: testEmail,
    role: 'author',
    home_id: 'home-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const generateToken = (accountId: string, email: string): string => {
    return jwt.sign(
      { id: accountId, email, role: 'author' },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '1h' },
    );
  };

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    // Create mock repositories
    mockAccountRepository = {
      findById: jest.fn(),
      findByEmail: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as any;

    mockAuthorRepository = {
      findBy: jest.fn(),
      deleteByAccountId: jest.fn(),
    } as any;

    mockCruxRepository = {
      findAllByAuthorId: jest.fn(),
      delete: jest.fn(),
    } as any;

    mockThemeRepository = {
      deleteByAuthorId: jest.fn(),
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
      .overrideProvider(AccountRepository)
      .useValue(mockAccountRepository)
      .overrideProvider(AuthorRepository)
      .useValue(mockAuthorRepository)
      .overrideProvider(CruxRepository)
      .useValue(mockCruxRepository)
      .overrideProvider(ThemeRepository)
      .useValue(mockThemeRepository)
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
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /account', () => {
    it('should return 200 and account data (happy path)', async () => {
      const token = generateToken(testAccountId, testEmail);
      mockAccountRepository.findById.mockResolvedValue(success(testAccountRaw));

      const response = await request(app.getHttpServer())
        .get('/account')
        .set(authHeader(token))
        .expect(200);

      expect(response.body).toMatchObject({
        id: testAccountId,
        email: testEmail,
        role: 'author',
      });
      expect(mockAccountRepository.findById).toHaveBeenCalledWith(
        testAccountId,
      );
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer()).get('/account').expect(401);
    });

    it('should return 401 when invalid token provided', async () => {
      await request(app.getHttpServer())
        .get('/account')
        .set(authHeader('invalid-token'))
        .expect(401);
    });

    it('should return 404 when account not found', async () => {
      const token = generateToken(testAccountId, testEmail);
      mockAccountRepository.findById.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .get('/account')
        .set(authHeader(token))
        .expect(404);
    });
  });

  describe('PATCH /account', () => {
    const updateAccountDto = {
      email: 'newemail@example.com',
    };

    it('should return 200 and update account (happy path)', async () => {
      const token = generateToken(testAccountId, testEmail);
      const updatedAccountRaw: AccountRaw = {
        ...testAccountRaw,
        email: updateAccountDto.email,
        updated: new Date(),
      };

      mockAccountRepository.findById.mockResolvedValue(success(testAccountRaw));
      mockAccountRepository.findByEmail.mockResolvedValue(success(null)); // No email conflict
      mockAccountRepository.update.mockResolvedValue(
        success(updatedAccountRaw),
      );

      const response = await request(app.getHttpServer())
        .patch('/account')
        .set(authHeader(token))
        .send(updateAccountDto)
        .expect(200);

      expect(response.body.email).toBe('newemail@example.com');
      expect(mockAccountRepository.update).toHaveBeenCalledWith(
        testAccountId,
        expect.objectContaining(updateAccountDto),
      );
    });

    it('should return 400 when email is invalid', async () => {
      const token = generateToken(testAccountId, testEmail);

      await request(app.getHttpServer())
        .patch('/account')
        .set(authHeader(token))
        .send({ email: 'not-an-email' })
        .expect(400);
    });

    it('should return 400 when extra fields provided', async () => {
      const token = generateToken(testAccountId, testEmail);

      await request(app.getHttpServer())
        .patch('/account')
        .set(authHeader(token))
        .send({
          email: 'valid@example.com',
          extraField: 'should be rejected',
        })
        .expect(400);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .patch('/account')
        .send(updateAccountDto)
        .expect(401);
    });

    it('should return 404 when account not found', async () => {
      const token = generateToken(testAccountId, testEmail);
      mockAccountRepository.findById.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .patch('/account')
        .set(authHeader(token))
        .send(updateAccountDto)
        .expect(404);
    });
  });

  describe('DELETE /account', () => {
    const deleteAccountDto = {
      confirmationText: 'DELETE MY ACCOUNT',
    };

    it('should return 204 and delete account (happy path)', async () => {
      const token = generateToken(testAccountId, testEmail);

      mockAccountRepository.findById.mockResolvedValue(success(testAccountRaw));
      mockAuthorRepository.findBy.mockResolvedValue(success(null)); // No author
      mockAuthorRepository.deleteByAccountId.mockResolvedValue(success(null));
      mockAccountRepository.delete.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete('/account')
        .set(authHeader(token))
        .send(deleteAccountDto)
        .expect(204);

      expect(mockAccountRepository.delete).toHaveBeenCalled();
    });

    it('should return 400 when confirmation text missing', async () => {
      const token = generateToken(testAccountId, testEmail);

      await request(app.getHttpServer())
        .delete('/account')
        .set(authHeader(token))
        .send({})
        .expect(400);
    });

    it('should return 400 when extra fields provided', async () => {
      const token = generateToken(testAccountId, testEmail);

      await request(app.getHttpServer())
        .delete('/account')
        .set(authHeader(token))
        .send({
          confirmationText: 'DELETE MY ACCOUNT',
          extraField: 'should be rejected',
        })
        .expect(400);
    });

    it('should return 401 when no token provided', async () => {
      await request(app.getHttpServer())
        .delete('/account')
        .send(deleteAccountDto)
        .expect(401);
    });

    it('should return 404 when account not found', async () => {
      const token = generateToken(testAccountId, testEmail);
      mockAccountRepository.findById.mockResolvedValue(success(null));

      await request(app.getHttpServer())
        .delete('/account')
        .set(authHeader(token))
        .send(deleteAccountDto)
        .expect(404);
    });
  });
});
