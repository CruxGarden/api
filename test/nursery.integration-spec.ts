import {
  Controller,
  Get,
  INestApplication,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { OptionalAuthGuard } from '../src/common/guards/optional-auth.guard';
import { LoggerService } from '../src/common/services/logger.service';
import { AuthRequest } from '../src/common/types/interfaces';
import { EnvValidator } from '../src/common/validators/env.validator';

@Controller()
class NurseryProbe {
  @Get('required')
  @UseGuards(AuthGuard)
  required(@Req() req: AuthRequest) {
    return { role: req.account?.role ?? null };
  }

  @Get('optional')
  @UseGuards(OptionalAuthGuard)
  optional(@Req() req: AuthRequest) {
    return { role: req.account?.role ?? null };
  }
}

describe('Nursery authentication boundary', () => {
  let app: INestApplication;
  const environment = process.env.NODE_ENV;
  const nursery = process.env.NURSERY_MODE;
  beforeAll(async () => {
    const logger = { debug: jest.fn(), warn: jest.fn() };
    const module = await Test.createTestingModule({
      controllers: [NurseryProbe],
      providers: [
        AuthGuard,
        OptionalAuthGuard,
        {
          provide: LoggerService,
          useValue: { createChildLogger: () => logger },
        },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    // One listener per fixture; Supertest must not reopen it for each request.
    await app.listen(0, '127.0.0.1');
  });
  afterEach(() => {
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
    if (nursery === undefined) delete process.env.NURSERY_MODE;
    else process.env.NURSERY_MODE = nursery;
  });
  afterAll(async () => {
    await app.close();
  });

  it('offers the demo identity only when explicitly enabled outside production', async () => {
    process.env.NODE_ENV = 'development';
    process.env.NURSERY_MODE = 'true';
    for (const route of ['required', 'optional']) {
      await request(app.getHttpServer())
        .get('/' + route)
        .expect(200, { role: 'keeper' });
    }
    process.env.NURSERY_MODE = 'false';
    await request(app.getHttpServer()).get('/required').expect(401);
    await request(app.getHttpServer())
      .get('/optional')
      .expect(200, { role: null });
  });

  it.each(['required', 'optional'])(
    'never grants the demo identity through %s authentication in production',
    async (route) => {
      process.env.NODE_ENV = 'production';
      process.env.NURSERY_MODE = 'true';
      await request(app.getHttpServer())
        .get('/' + route)
        .expect(500);
    },
  );

  it('refuses the unsafe production configuration before starting the API', () => {
    process.env.NODE_ENV = 'production';
    process.env.NURSERY_MODE = 'true';
    expect(() => EnvValidator.validate()).toThrow(
      'NURSERY_MODE cannot be enabled in production',
    );
  });
});
