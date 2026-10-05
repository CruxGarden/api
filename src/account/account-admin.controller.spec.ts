import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request = require('supertest');
import { createRequestValidationPipe } from '../common/validation/request-validation';
import { AuthGuard } from '../common/guards/auth.guard';
import { AccountAdminController } from './account-admin.controller';
import { AccountService } from './account.service';

const operator = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';

/** Real controller, AdminGuard, validation and service; repository is a fixture. */
describe('admin account suspension (ADR 0083)', () => {
  let app: INestApplication;
  let rows: Map<string, Record<string, unknown>>;
  const repo = {
    setSuspension: jest.fn(
      async (
        id: string,
        hold: { reason: string; operatorId: string } | null,
      ) => {
        const row = rows.get(id);
        if (!row) return { data: null, error: null };
        Object.assign(row, {
          suspended: hold ? new Date('2026-10-05T12:00:00Z') : null,
          suspended_reason: hold?.reason ?? null,
          suspended_by: hold?.operatorId ?? null,
        });
        return { data: row, error: null };
      },
    ),
    search: jest.fn(async (query: string) => ({
      data: [...rows.values()]
        .filter(
          (r) =>
            !query ||
            String(r.email).includes(query) ||
            String(r.username).includes(query),
        )
        .flatMap((r) => [r, r]), // two authors → one result
      error: null,
    })),
  };
  const logger = {
    createChildLogger: () => ({ info: jest.fn(), warn: jest.fn() }),
  };

  beforeAll(async () => {
    const none = {} as never;
    const service = new AccountService(
      repo as never,
      none,
      none,
      none,
      none,
      none,
      logger as never,
      none,
      none,
      none,
    );
    const module = await Test.createTestingModule({
      controllers: [AccountAdminController],
      providers: [{ provide: AccountService, useValue: service }],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context) => {
          const req = context.switchToHttp().getRequest();
          if (!req.headers['x-test-role']) return false;
          req.account = { id: operator, role: req.headers['x-test-role'] };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(createRequestValidationPipe());
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => {
    rows = new Map([
      [
        target,
        {
          id: target,
          email: 'person@example.com',
          username: 'person',
          role: 'author',
          created: new Date('2026-09-01T00:00:00Z'),
          suspended: null,
          suspended_reason: null,
        },
      ],
    ]);
  });
  afterAll(() => app.close());

  it('is admin-only', async () => {
    const server = app.getHttpServer();
    await request(server).get('/admin/accounts').expect(403);
    await request(server)
      .get('/admin/accounts')
      .set('x-test-role', 'author')
      .expect(403);
    await request(server)
      .post(`/admin/accounts/${target}/suspend`)
      .set('x-test-role', 'author')
      .send({ reason: 'spam' })
      .expect(403);
    await request(server)
      .post(`/admin/accounts/${target}/unsuspend`)
      .set('x-test-role', 'author')
      .expect(403);
    expect(repo.setSuspension).not.toHaveBeenCalled();
  });

  it('suspends with a reason, finds the account, and lifts the hold', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post(`/admin/accounts/${target}/suspend`)
      .set('x-test-role', 'admin')
      .send({})
      .expect(400);
    await request(server)
      .post(`/admin/accounts/not-a-uuid/suspend`)
      .set('x-test-role', 'admin')
      .send({ reason: 'spam' })
      .expect(400);
    const held = await request(server)
      .post(`/admin/accounts/${target}/suspend`)
      .set('x-test-role', 'keeper')
      .send({ reason: '  repeated spam  ' })
      .expect(200);
    expect(held.body).toEqual({
      id: target,
      email: 'person@example.com',
      username: 'person',
      role: 'author',
      created: '2026-09-01T00:00:00.000Z',
      suspended: '2026-10-05T12:00:00.000Z',
      suspendedReason: 'repeated spam',
    });
    expect(repo.setSuspension).toHaveBeenCalledWith(target, {
      reason: 'repeated spam',
      operatorId: operator,
    });
    const found = await request(server)
      .get('/admin/accounts?query=person')
      .set('x-test-role', 'admin')
      .expect(200);
    expect(found.body).toHaveLength(1);
    expect(found.body[0].suspended).toBe('2026-10-05T12:00:00.000Z');
    const lifted = await request(server)
      .post(`/admin/accounts/${target}/unsuspend`)
      .set('x-test-role', 'admin')
      .expect(200);
    expect(lifted.body.suspended).toBeNull();
    await request(server)
      .post(`/admin/accounts/33333333-3333-4333-8333-333333333333/suspend`)
      .set('x-test-role', 'admin')
      .send({ reason: 'spam' })
      .expect(404);
  });

  it('refuses suspending your own account', async () => {
    await request(app.getHttpServer())
      .post(`/admin/accounts/${operator}/suspend`)
      .set('x-test-role', 'admin')
      .send({ reason: 'oops' })
      .expect(400);
  });
});
