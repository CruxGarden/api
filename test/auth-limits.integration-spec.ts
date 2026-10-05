import { createRequestValidationPipe } from '../src/common/validation/request-validation';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule, TOO_MANY_REQUESTS } from '../src/app.module';
import { RedisService } from '../src/common/services/redis.service';
import { EmailService } from '../src/common/services/email.service';
import { DbService } from '../src/common/services/db.service';
import { AccountRepository } from '../src/account/account.repository';
import { AuthorRepository } from '../src/author/author.repository';
import { HomeService } from '../src/home/home.service';
import {
  CODE_REQUESTS_LIMITED,
  LOGIN_ATTEMPTS_LIMITED,
} from '../src/auth/auth.service';
import { MockRedisService } from './mocks/redis.mock';
import { MockEmailService } from './mocks/email.mock';
import { MockDbService } from './mocks/db.mock';
import { generateTestEmail } from './test-utils';
import { version } from '../package.json';

/** Sign-in abuse limits through the real guards, throttler and AuthService. */
describe('Auth abuse limits', () => {
  let app: INestApplication;
  let mockRedis: MockRedisService;
  let mockEmail: MockEmailService;
  const env = { ...process.env };
  const account = (email: string) => ({
    id: 'account-123',
    email,
    role: 'author',
    home_id: 'home-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  });
  const accounts = {
    findByEmail: jest.fn(async (email: string) => ({
      data: account(email),
      error: null,
    })),
    create: jest.fn(),
  };
  const post = (path: string, body: object) =>
    request(app.getHttpServer())
      .post(path)
      .set('API-VERSION', version)
      .send(body);

  beforeAll(async () => {
    // Per-IP ceilings out of the way until the tests that are about them.
    process.env.AUTH_CODE_PER_MINUTE_PER_IP = '1000';
    process.env.AUTH_LOGIN_PER_MINUTE_PER_IP = '1000';
    delete process.env.AUTH_TOKEN_PER_MINUTE_PER_IP;
    mockRedis = new MockRedisService();
    mockEmail = new MockEmailService();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RedisService)
      .useValue(mockRedis)
      .overrideProvider(EmailService)
      .useValue(mockEmail)
      .overrideProvider(DbService)
      .useValue(new MockDbService())
      .overrideProvider(AccountRepository)
      .useValue(accounts)
      .overrideProvider(AuthorRepository)
      .useValue({
        findBy: jest.fn().mockResolvedValue({ data: null, error: null }),
      })
      .overrideProvider(HomeService)
      .useValue({ primary: jest.fn() })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createRequestValidationPipe());
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    process.env = env;
    await app.close();
  });

  beforeEach(async () => {
    await mockRedis.flushDb();
    mockEmail.clear();
  });

  it('sends at most five codes to one email in the window, whoever it belongs to', async () => {
    const email = generateTestEmail();
    for (let i = 0; i < 5; i++) await post('/auth/code', { email }).expect(200);

    const refused = await post('/auth/code', { email }).expect(429);

    expect(refused.body.message).toBe(CODE_REQUESTS_LIMITED);
    expect(mockEmail.getEmailCount()).toBe(5);
    // Another address is unaffected, and nothing above consulted an account.
    await post('/auth/code', { email: generateTestEmail() }).expect(200);
    expect(accounts.findByEmail).not.toHaveBeenCalled();
  });

  it('locks code verification after five wrong codes until a new code is requested', async () => {
    const email = generateTestEmail();
    await post('/auth/code', { email }).expect(200);
    const first = mockEmail.extractCodeFromLastEmail();
    for (let i = 0; i < 5; i++)
      await post('/auth/login', { email, code: `wrong-${i}` }).expect(401);

    const locked = await post('/auth/login', { email, code: first }).expect(
      429,
    );
    expect(locked.body.message).toBe(LOGIN_ATTEMPTS_LIMITED);

    await post('/auth/code', { email }).expect(200);
    const fresh = mockEmail.extractCodeFromLastEmail();
    const signedIn = await post('/auth/login', { email, code: fresh }).expect(
      200,
    );
    expect(signedIn.body.accessToken).toBeTruthy();
  });

  it('answers a wrong code the same way for an unknown email', async () => {
    const response = await post('/auth/login', {
      email: generateTestEmail(),
      code: 'wrong',
    }).expect(401);
    expect(response.body.message).toBe('Unauthorized');
  });

  it('limits token refreshes per address with a plain message', async () => {
    process.env.AUTH_TOKEN_PER_MINUTE_PER_IP = '2';
    await post('/auth/token', { refreshToken: 'unknown' }).expect(401);
    await post('/auth/token', { refreshToken: 'unknown' }).expect(401);

    const refused = await post('/auth/token', {
      refreshToken: 'unknown',
    }).expect(429);

    expect(refused.body.message).toBe(TOO_MANY_REQUESTS);
  });

  it('limits code requests per address across different emails', async () => {
    // Earlier tests already spent part of this minute's allowance from this
    // address, so the ceiling is reached within twelve further requests.
    process.env.AUTH_CODE_PER_MINUTE_PER_IP = '12';
    let refused: request.Response | undefined;
    for (let i = 0; i < 12 && !refused; i++) {
      const response = await post('/auth/code', { email: generateTestEmail() });
      if (response.status === 429) refused = response;
      else expect(response.status).toBe(200);
    }

    expect(refused?.body.message).toBe(TOO_MANY_REQUESTS);
    expect(mockEmail.getEmailCount()).toBeLessThan(12);
  });
});
