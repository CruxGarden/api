import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/common/services/redis.service';
import { EmailService } from '../src/common/services/email.service';
import { DbService } from '../src/common/services/db.service';
import { AccountRepository } from '../src/account/account.repository';
import { AuthorRepository } from '../src/author/author.repository';
import { HomeService } from '../src/home/home.service';
import { MockRedisService } from './mocks/redis.mock';
import { MockEmailService } from './mocks/email.mock';
import { MockDbService } from './mocks/db.mock';
import { authHeader, generateTestEmail } from './test-utils';
import { version } from '../package.json';

const API_VERSION = version;

describe('Auth Integration Tests', () => {
  let app: INestApplication;
  let mockRedis: MockRedisService;
  let mockEmail: MockEmailService;
  let mockDb: MockDbService;
  let mockAccountRepository: any;
  let mockAuthorRepository: any;

  beforeAll(async () => {
    // Create mock instances
    mockRedis = new MockRedisService();
    mockEmail = new MockEmailService();
    mockDb = new MockDbService();

    // Create mock repositories
    mockAccountRepository = {
      findByEmail: jest.fn(),
      create: jest.fn(),
    };

    mockAuthorRepository = {
      create: jest.fn(),
      findBy: jest.fn().mockResolvedValue({ data: null, error: null }), // No existing username conflicts
    };

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
      .overrideProvider(RedisService)
      .useValue(mockRedis)
      .overrideProvider(EmailService)
      .useValue(mockEmail)
      .overrideProvider(DbService)
      .useValue(mockDb)
      .overrideProvider(AccountRepository)
      .useValue(mockAccountRepository)
      .overrideProvider(AuthorRepository)
      .useValue(mockAuthorRepository)
      .overrideProvider(HomeService)
      .useValue(mockHomeService)
      .compile();

    app = moduleFixture.createNestApplication();

    // Apply same validation pipe as production
    const { ValidationPipe } = await import('@nestjs/common');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clear mocks between tests
    await mockRedis.flushDb();
    mockEmail.clear();
    mockDb.clearAllTables();
    jest.clearAllMocks();
  });

  describe('POST /auth/code', () => {
    const testEmail = generateTestEmail();

    it('should send auth code email for new user', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/code')
        .set('API-VERSION', API_VERSION)
        .send({ email: testEmail })
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('Auth Code emailed');

      // Verify email was sent
      expect(mockEmail.getEmailCount()).toBe(1);
      const sentEmail = mockEmail.getLastEmail();
      expect(sentEmail.email).toBe(testEmail.toLowerCase());
      expect(sentEmail.subject).toBe('Auth Code');

      // Verify auth code was stored in Redis
      const authCode = mockEmail.extractCodeFromLastEmail();
      expect(authCode).toBeTruthy();

      const storedEmail = await mockRedis.get(`crux:auth:code:${authCode}`);
      expect(storedEmail).toBe(testEmail.toLowerCase());
    });

    it('should send auth code email for existing user', async () => {
      // First request
      await request(app.getHttpServer())
        .post('/auth/code')
        .set('API-VERSION', API_VERSION)
        .send({ email: testEmail })
        .expect(200);

      // Second request
      await request(app.getHttpServer())
        .post('/auth/code')
        .set('API-VERSION', API_VERSION)
        .send({ email: testEmail })
        .expect(200);

      // Should have sent 2 emails
      expect(mockEmail.getEmailCount()).toBe(2);
    });

    it('should reject invalid email format', async () => {
      await request(app.getHttpServer())
        .post('/auth/code')
        .set('API-VERSION', API_VERSION)
        .send({ email: 'invalid-email' })
        .expect(400);

      expect(mockEmail.getEmailCount()).toBe(0);
    });

    it('should reject missing email', async () => {
      await request(app.getHttpServer())
        .post('/auth/code')
        .set('API-VERSION', API_VERSION)
        .send({})
        .expect(400);
    });

    it('should normalize email to lowercase', async () => {
      const upperEmail = 'TEST@EXAMPLE.COM';

      await request(app.getHttpServer())
        .post('/auth/code')
        .set('API-VERSION', API_VERSION)
        .send({ email: upperEmail })
        .expect(200);

      const sentEmail = mockEmail.getLastEmail();
      expect(sentEmail.email).toBe(upperEmail.toLowerCase());
    });
  });

  describe('POST /auth/login', () => {
    const testEmail = generateTestEmail();
    let authCode: string;

    beforeEach(async () => {
      // Request auth code
      await request(app.getHttpServer())
        .post('/auth/code')
        .set('API-VERSION', API_VERSION)
        .send({ email: testEmail })
        .expect(200);

      authCode = mockEmail.extractCodeFromLastEmail()!;
    });

    it('should reject login with invalid code', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('API-VERSION', API_VERSION)
        .send({
          email: testEmail,
          code: 'invalid-code',
        })
        .expect(401);
    });

    it('should reject login with wrong email', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('API-VERSION', API_VERSION)
        .send({
          email: 'wrong@example.com',
          code: authCode,
        })
        .expect(401);
    });

    it('should reject login with missing email', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('API-VERSION', API_VERSION)
        .send({ code: authCode })
        .expect(400);
    });

    it('should reject login with missing code', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('API-VERSION', API_VERSION)
        .send({ email: testEmail })
        .expect(400);
    });

    it('should reject login with expired code', async () => {
      // Fast-forward time by setting expired entry directly
      await mockRedis.set(
        `crux:auth:code:expired-code`,
        testEmail.toLowerCase(),
        -1,
      );

      await request(app.getHttpServer())
        .post('/auth/login')
        .set('API-VERSION', API_VERSION)
        .send({
          email: testEmail,
          code: 'expired-code',
        })
        .expect(401);
    });

    it('should successfully login new user with valid code', async () => {
      const accountId = 'test-account-id-123';
      const authorId = 'test-author-id-456';

      // Mock: Account doesn't exist yet (new user signup)
      mockAccountRepository.findByEmail.mockResolvedValue({
        data: null,
        error: null,
      });

      // Mock: Account creation succeeds
      mockAccountRepository.create.mockResolvedValue({
        data: {
          id: accountId,
          key: 'test-key',
          email: testEmail.toLowerCase(),
          role: 'author',
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          deleted: null,
        },
        error: null,
      });

      // Mock: Author creation succeeds
      mockAuthorRepository.create.mockResolvedValue({
        data: {
          id: authorId,
          key: 'author-key',
          account_id: accountId,
          username: testEmail.split('@')[0],
          display_name: testEmail.split('@')[0],
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          deleted: null,
        },
        error: null,
      });

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .set('API-VERSION', API_VERSION)
        .send({ email: testEmail, code: authCode })
        .expect(200); // Login returns 200 OK

      // Verify response has JWT tokens
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body).toHaveProperty('expiresIn');
      expect(typeof response.body.accessToken).toBe('string');
      expect(typeof response.body.refreshToken).toBe('string');
      expect(response.body.expiresIn).toBe(3600); // 1 hour

      // Verify refresh token was stored in Redis
      const storedGrantId = await mockRedis.get(
        `crux:auth:refresh:${response.body.refreshToken}`,
      );
      expect(storedGrantId).toBeTruthy();

      // Verify auth code was removed after use
      const codeStillExists = await mockRedis.get(`crux:auth:code:${authCode}`);
      expect(codeStillExists).toBeNull();

      // Verify account and author were created
      expect(mockAccountRepository.create).toHaveBeenCalledTimes(1);
      expect(mockAuthorRepository.create).toHaveBeenCalledTimes(1);
    });

    it('should successfully login existing user with valid code', async () => {
      const existingAccountId = 'existing-account-id';

      // Mock: Account already exists
      mockAccountRepository.findByEmail.mockResolvedValue({
        data: {
          id: existingAccountId,
          key: 'existing-key',
          email: testEmail.toLowerCase(),
          role: 'author',
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          deleted: null,
        },
        error: null,
      });

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .set('API-VERSION', API_VERSION)
        .send({ email: testEmail, code: authCode })
        .expect(200); // Login returns 200 OK

      // Verify response has JWT tokens
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body).toHaveProperty('expiresIn');

      // Verify account was NOT created (existing user)
      expect(mockAccountRepository.create).not.toHaveBeenCalled();
      expect(mockAuthorRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/token (refresh)', () => {
    it('should reject refresh with invalid token', async () => {
      await request(app.getHttpServer())
        .post('/auth/token')
        .set('API-VERSION', API_VERSION)
        .send({ refreshToken: 'invalid-token' })
        .expect(401);
    });

    it('should reject refresh with missing token', async () => {
      await request(app.getHttpServer())
        .post('/auth/token')
        .set('API-VERSION', API_VERSION)
        .send({})
        .expect(400);
    });

    it('should reject refresh with expired token', async () => {
      // Set expired refresh token
      await mockRedis.set('crux:auth:refresh:expired-token', 'grant-id', -1);

      await request(app.getHttpServer())
        .post('/auth/token')
        .set('API-VERSION', API_VERSION)
        .send({ refreshToken: 'expired-token' })
        .expect(401);
    });

    it('should successfully refresh tokens with valid refresh token', async () => {
      const testEmail = 'refresh-test@example.com';
      const grantId = 'test-grant-id';
      const oldRefreshToken = 'old-refresh-token';

      // Setup: Store grant ID and refresh token in Redis
      await mockRedis.set(`crux:auth:grant:email:${testEmail}`, grantId);
      await mockRedis.set(`crux:auth:grant:id:${grantId}`, testEmail);
      await mockRedis.set(`crux:auth:refresh:${oldRefreshToken}`, grantId);

      // Mock: Account exists
      mockAccountRepository.findByEmail.mockResolvedValue({
        data: {
          id: 'account-id',
          key: 'account-key',
          email: testEmail,
          role: 'author',
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          deleted: null,
        },
        error: null,
      });

      const response = await request(app.getHttpServer())
        .post('/auth/token')
        .set('API-VERSION', API_VERSION)
        .send({ refreshToken: oldRefreshToken })
        .expect(200); // Token refresh returns 200 OK

      // Verify new tokens were issued
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body).toHaveProperty('expiresIn');
      expect(response.body.refreshToken).not.toBe(oldRefreshToken); // New token issued

      // Verify old refresh token was removed
      const oldTokenExists = await mockRedis.get(
        `crux:auth:refresh:${oldRefreshToken}`,
      );
      expect(oldTokenExists).toBeNull();

      // Verify new refresh token was stored
      const newGrantId = await mockRedis.get(
        `crux:auth:refresh:${response.body.refreshToken}`,
      );
      expect(newGrantId).toBe(grantId);
    });
  });

  describe('GET /auth/profile', () => {
    it('should reject profile request without token', async () => {
      await request(app.getHttpServer())
        .get('/auth/profile')
        .set('API-VERSION', API_VERSION)
        .expect(401); // AuthGuard returns 401 when no token provided
    });

    it('should reject profile request with invalid token', async () => {
      await request(app.getHttpServer())
        .get('/auth/profile')
        .set('API-VERSION', API_VERSION)
        .set(authHeader('invalid-token'))
        .expect(401);
    });

    it('should reject profile request with malformed token', async () => {
      await request(app.getHttpServer())
        .get('/auth/profile')
        .set('API-VERSION', API_VERSION)
        .set(authHeader('not.a.jwt'))
        .expect(401);
    });

    it('should successfully get profile with valid token', async () => {
      const testEmail = 'profile-test@example.com';
      const jwt = require('jsonwebtoken');

      // Create a valid JWT token
      const token = jwt.sign(
        {
          id: 'test-account-id',
          email: testEmail,
          role: 'author',
          grantId: 'test-grant-id',
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        process.env.JWT_SECRET,
        { algorithm: 'HS256' },
      );

      // Mock: Account exists
      mockAccountRepository.findByEmail.mockResolvedValue({
        data: {
          id: 'test-account-id',
          key: 'account-key',
          email: testEmail,
          role: 'author',
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          deleted: null,
        },
        error: null,
      });

      const response = await request(app.getHttpServer())
        .get('/auth/profile')
        .set('API-VERSION', API_VERSION)
        .set(authHeader(token))
        .expect(200);

      // Verify profile data
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('email', testEmail);
      expect(response.body).toHaveProperty('role', 'author');
    });
  });

  describe('DELETE /auth/logout', () => {
    it('should reject logout without token', async () => {
      await request(app.getHttpServer())
        .delete('/auth/logout')
        .set('API-VERSION', API_VERSION)
        .expect(401); // AuthGuard returns 401 when no token provided
    });

    it('should reject logout with invalid token', async () => {
      await request(app.getHttpServer())
        .delete('/auth/logout')
        .set('API-VERSION', API_VERSION)
        .set(authHeader('invalid-token'))
        .expect(401); // AuthGuard returns 401 for invalid/malformed tokens
    });

    it('should successfully logout with valid token', async () => {
      const testEmail = 'logout-test@example.com';
      const grantId = 'test-grant-id';
      const jwt = require('jsonwebtoken');

      // Setup: Store grant ID in Redis
      await mockRedis.set(`crux:auth:grant:email:${testEmail}`, grantId);
      await mockRedis.set(`crux:auth:grant:id:${grantId}`, testEmail);

      // Create a valid JWT token
      const token = jwt.sign(
        {
          id: 'test-account-id',
          email: testEmail,
          role: 'author',
          grantId: grantId,
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        process.env.JWT_SECRET,
        { algorithm: 'HS256' },
      );

      await request(app.getHttpServer())
        .delete('/auth/logout')
        .set('API-VERSION', API_VERSION)
        .set(authHeader(token))
        .expect(204); // DELETE returns 204 No Content

      // Verify grant was removed from Redis
      const grantByEmail = await mockRedis.get(
        `crux:auth:grant:email:${testEmail}`,
      );
      const grantById = await mockRedis.get(`crux:auth:grant:id:${grantId}`);
      expect(grantByEmail).toBeNull();
      expect(grantById).toBeNull();
    });
  });

  describe('API Version Header', () => {
    it('should allow requests without API version header (defaults to current)', async () => {
      // The guard allows requests without version and defaults to current version
      await request(app.getHttpServer()).get('/').expect(200);
    });

    it('should accept requests with valid API version header', async () => {
      await request(app.getHttpServer())
        .get('/')
        .set('API-VERSION', API_VERSION)
        .expect(200);
    });

    it('should reject requests with invalid API version', async () => {
      await request(app.getHttpServer())
        .get('/')
        .set('API-VERSION', '999.0.0')
        .expect(400);
    });
  });

  describe('Rate Limiting', () => {
    it('should allow multiple requests within limit', async () => {
      const testEmailRateLimit = generateTestEmail();

      // Make requests sequentially to avoid connection issues
      for (let i = 0; i < 5; i++) {
        const response = await request(app.getHttpServer())
          .post('/auth/code')
          .set('API-VERSION', API_VERSION)
          .send({ email: testEmailRateLimit });

        expect(response.status).toBe(200);
      }

      // Verify all emails were sent
      expect(mockEmail.getEmailCount()).toBe(5);
    });
  });

  describe('Input Validation', () => {
    it('should reject extra fields in auth code request', async () => {
      await request(app.getHttpServer())
        .post('/auth/code')
        .set('API-VERSION', API_VERSION)
        .send({
          email: generateTestEmail(),
          extraField: 'should be rejected',
        })
        .expect(400);
    });

    it('should reject extra fields in login request', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('API-VERSION', API_VERSION)
        .send({
          email: generateTestEmail(),
          code: '123456',
          extraField: 'should be rejected',
        })
        .expect(400);
    });
  });
});
