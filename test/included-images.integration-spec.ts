import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import * as request from 'supertest';
import { postgresFixture } from './support/postgres';
import { InferenceController } from '../src/inference/inference.controller';
import { InferenceService } from '../src/inference/inference.service';
import { InferenceRepository } from '../src/inference/inference.repository';
import { IncludedImageService } from '../src/inference/image.service';
import { IMAGE_RESERVATION } from '../src/inference/image-policy';
import { BillingService } from '../src/billing/billing.service';
import { BillingRepository } from '../src/billing/billing.repository';
import { MockBillingProvider } from '../src/billing/provider';
import { DbService } from '../src/common/services/db.service';
import { LoggerService } from '../src/common/services/logger.service';

// Actual HTTP, signed JWTs, account/plan lookup and PostgreSQL reservations.
// Only the external image provider and email delivery are replaced.
describe('included images over authenticated HTTP and PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  let app: INestApplication;
  let repo: InferenceRepository;
  const account = randomUUID(),
    home = randomUUID();
  const env = { ...process.env };
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGNgmMDKwMDAxMDAwMAAAAwWAKUF4Je/AAAAAElFTkSuQmCC';
  const usage = {
    input_tokens: 30,
    output_tokens: 1000,
    input_tokens_details: { text_tokens: 20, image_tokens: 10 },
  };
  const generate = jest.fn(async () => ({ data: [{ b64_json: png }], usage }));
  const edit = jest.fn(async () => ({ data: [{ b64_json: png }], usage }));
  let token: string;
  beforeAll(async () => {
    process.env.JWT_SECRET = 'isolated-image-http-test-secret';
    process.env.INCLUDED_INFERENCE_ENABLED = '1';
    process.env.INCLUDED_OPENAI_API_KEY = 'fixture-unused';
    process.env.STRIPE_TRIAL_DAYS = '0';
    delete process.env.BILLING_PROVIDER;
    delete process.env.STRIPE_SECRET_KEY;
    fixture = await postgresFixture();
    const db = fixture.db;
    await db.query()('homes').insert({
      id: home,
      name: 'Image fixture',
      type: 'home',
      kind: 'garden',
      primary: true,
    });
    await db.query()('accounts').insert({
      id: account,
      home_id: home,
      email: 'images@example.test',
      role: 'author',
    });
    const logger = new LoggerService();
    const billing = new BillingService(
      new BillingRepository(db, logger),
      logger,
      { send: jest.fn(async () => null) } as never,
    );
    billing.useProvider(new MockBillingProvider(), {
      price_month: { planId: 'gardener', interval: 'month' },
    });
    await billing.checkout(account, 'gardener', 'month');
    repo = new InferenceRepository(db);
    const images = new IncludedImageService(repo, billing, logger);
    jest
      .spyOn(images as never, 'provider')
      .mockReturnValue({ images: { generate, edit } } as never);
    const module = await Test.createTestingModule({
      controllers: [InferenceController],
      providers: [
        { provide: IncludedImageService, useValue: images },
        {
          provide: InferenceService,
          useValue: new InferenceService(repo, billing, logger),
        },
        { provide: DbService, useValue: db },
        { provide: LoggerService, useValue: logger },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    token = jwt.sign({ id: account, role: 'author' }, process.env.JWT_SECRET!);
  }, 60_000);
  beforeEach(async () => {
    generate.mockClear();
    edit.mockClear();
    await fixture.db.query()('inference_requests').delete();
  });
  afterAll(async () => {
    await app?.close();
    await fixture?.close();
    process.env = { ...env };
  });
  const submit = (
    id = randomUUID(),
    body: Record<string, unknown> = { prompt: 'A garden', size: '1024x1024' },
  ) =>
    request(app.getHttpServer())
      .post('/inference/images')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', id)
      .send(body);
  it('saves one charge per request, refuses replay, edits, and reports the shared allowance', async () => {
    const id = randomUUID();
    const first = await submit(id).expect(200);
    expect(first.body).toMatchObject({
      image: png,
      requestId: id,
      mimeType: 'image/png',
    });
    await submit(id).expect(409);
    expect(generate).toHaveBeenCalledTimes(1);
    await submit(randomUUID(), {
      prompt: 'Lighter background',
      size: '1024x1024',
      image: png,
    }).expect(200);
    expect(edit).toHaveBeenCalledTimes(1);
    const rows = (await repo.rows(account)).data!;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => Number(r.charged_microdollars) === 30_180)).toBe(
      true,
    );
    const state = await request(app.getHttpServer())
      .get('/inference/usage')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(state.body.imagesAvailable).toBe(true);
    expect(state.body.windows[0].usedMicrodollars).toBe(60_360);
  });
  it('refuses unauthenticated, closed-account and malformed calls before spending', async () => {
    await request(app.getHttpServer())
      .post('/inference/images')
      .send({})
      .expect(401);
    await submit(randomUUID(), {
      prompt: 'A garden',
      size: '1024x1024',
      image: 'https://private.invalid',
    }).expect(400);
    await fixture.db
      .query()('accounts')
      .where({ id: account })
      .update({ deleted: new Date() });
    try {
      await submit().expect(401);
    } finally {
      await fixture.db
        .query()('accounts')
        .where({ id: account })
        .update({ deleted: null });
    }
    expect(generate).not.toHaveBeenCalled();
    expect((await repo.rows(account)).data).toEqual([]);
  });
  it('shares chat reservations and prevents an image from exceeding the allowance', async () => {
    const id = randomUUID();
    await repo.reserve(account, id, [{ model: 'chat', amount: 500_000 }], {
      fiveHour: 750_000,
      thirtyDay: 4_000_000,
    });
    await repo.settle(account, id, 500_000, null, 'uncertain');
    await submit().expect(429);
    expect(generate).not.toHaveBeenCalled();
    expect(IMAGE_RESERVATION).toBeGreaterThan(250_000);
  });
});
