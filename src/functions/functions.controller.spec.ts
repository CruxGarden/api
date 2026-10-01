import { DbService } from '../common/services/db.service';
import { MockDbService } from '../../test/mocks/db.mock';
import { PublishedAuthService } from '../published-auth/published-auth.service';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import * as request from 'supertest';
import { Subject } from 'rxjs';
import { FunctionsController } from './functions.controller';
import { FunctionsService, RunResult } from './functions.service';
import { AuthorService } from '../author/author.service';
import { CruxService } from '../crux/crux.service';
import { LoggerService } from '../common/services/logger.service';

/** Real HTTP and authentication, with an adversarial handler result at the isolate boundary. */
describe('Function HTTP response boundary', () => {
  let app: INestApplication;
  let result: RunResult;
  const secret = 'function-http-test-signing-key';
  const functions = {
    call: jest.fn(async () => result),
    emit: jest.fn(async () => ({ handlers: 1, results: { handler: result } })),
    events: new Subject(),
  };
  const token = (id: string) => `Bearer ${jwt.sign({ id }, secret)}`;
  const previous = { ...process.env };
  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    delete process.env.NURSERY_MODE;
    const tokenDb = new MockDbService();
    tokenDb.setTable('accounts', [
      { id: 'owner', deleted: null },
      { id: 'other', deleted: null },
    ]);
    const module = await Test.createTestingModule({
      controllers: [FunctionsController],
      providers: [
        { provide: DbService, useValue: tokenDb },
        { provide: PublishedAuthService, useValue: {} },
        { provide: FunctionsService, useValue: functions },
        {
          provide: CruxService,
          useValue: { findById: async () => ({ authorId: 'author-owner' }) },
        },
        {
          provide: AuthorService,
          useValue: {
            findByAccountId: async (id: string) => ({ id: `author-${id}` }),
          },
        },
        {
          provide: LoggerService,
          useValue: { createChildLogger: () => ({ warn: jest.fn() }) },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    // One listener per fixture; Supertest must not reopen it for each request.
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
    process.env = previous;
  });
  beforeEach(() => {
    result = {
      status: 200,
      body: 'hello',
      logs: ['a private diagnostic'],
      ms: 1,
    };
  });

  it('keeps HTML inert on the API origin and refuses handler-controlled security headers', async () => {
    result.contentType = 'text/html; charset=utf-8';
    result.body = '<script>fetch("/account")</script>';
    result.headers = {
      'Set-Cookie': 'session=forged',
      'Content-Security-Policy': 'sandbox allow-scripts allow-same-origin',
      'Access-Control-Allow-Origin': 'https://attacker.test',
      'Content-Type': 'application/javascript',
      'X-Crux-Function-Logs': 'forged',
      'Cache-Control': 'public, max-age=9999',
    };
    const response = await request(app.getHttpServer())
      .get('/fn/crux/hello')
      .expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['content-security-policy']).toBe(
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['x-crux-function-logs']).toBeUndefined();
  });

  it.each([undefined, 'other', 'owner'])(
    'returns HTTP and event diagnostics only to the owner (%s)',
    async (account) => {
      const headers = account ? { Authorization: token(account) } : {};
      const response = await request(app.getHttpServer())
        .get('/fn/crux/hello')
        .set(headers)
        .expect(200);
      expect(response.headers['x-crux-function-logs']).toBe(
        account === 'owner' ? encodeURIComponent(result.logs[0]) : undefined,
      );
      const event = await request(app.getHttpServer())
        .post('/events/crux/hello')
        .set(headers)
        .send({})
        .expect(202);
      expect(event.body.results.handler.logs).toEqual(
        account === 'owner' ? result.logs : [],
      );
    },
  );

  it('retains ordinary JSON and safe redirects', async () => {
    const json = await request(app.getHttpServer())
      .get('/fn/crux/hello')
      .expect(200);
    expect(json.body).toBe('hello');
    result = {
      ...result,
      status: 303,
      body: '',
      contentType: 'text/plain',
      headers: { Location: '/done' },
    };
    const redirect = await request(app.getHttpServer())
      .get('/fn/crux/hello')
      .expect(303);
    expect(redirect.headers.location).toBe('/done');
  });

  it('refuses executable redirects and downgrades undeclared media types to plain text', async () => {
    result.contentType = 'application/javascript';
    result.headers = { Location: 'javascript:alert(document.domain)' };
    const response = await request(app.getHttpServer())
      .get('/fn/crux/hello')
      .expect(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('normalizes invalid handler status codes without breaking the response', async () => {
    result.status = 99;
    const response = await request(app.getHttpServer())
      .get('/fn/crux/hello')
      .expect(500);
    expect(response.body).toEqual({
      error: 'Invalid function response status',
    });
  });
});
