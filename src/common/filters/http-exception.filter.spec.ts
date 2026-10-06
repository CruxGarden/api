import {
  BadRequestException,
  Controller,
  Get,
  INestApplication,
  InternalServerErrorException,
  Param,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { HttpExceptionFilter } from './http-exception.filter';
import { LoggerService } from '../services/logger.service';

@Controller('errors')
class ErrorFixture {
  @Get(':kind')
  fail(@Param('kind') kind: string) {
    if (kind === 'validation')
      throw new BadRequestException(['title is required']);
    const detail = 'SQL query failed: accounts.email = private@example.test';
    if (kind === 'wrapped') throw new InternalServerErrorException(detail);
    if (kind === 'unique')
      throw Object.assign(new Error(detail), { code: '23505' });
    if (kind === 'sqlite-unique')
      throw new InternalServerErrorException(detail, {
        cause: Object.assign(new Error(detail), {
          code: 'SQLITE_CONSTRAINT_UNIQUE',
        }),
      });
    throw new Error(detail);
  }
}

describe('HTTP error disclosure boundary', () => {
  let app: INestApplication;
  const error = jest.fn();
  const warn = jest.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ErrorFixture],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(
      new HttpExceptionFilter({
        createChildLogger: () => ({ error, warn }),
      } as unknown as LoggerService),
    );
    // One listener per fixture; Supertest must not reopen it for each request.
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => app.close());

  it.each(['raw', 'wrapped'])(
    'keeps %s database failure details in server logs only',
    async (kind) => {
      const response = await request(app.getHttpServer())
        .get(`/errors/${kind}`)
        .expect(500);
      expect(response.body.message).toBe('Internal server error');
      expect(response.body).not.toHaveProperty('stack');
      expect(JSON.stringify(response.body)).not.toContain(
        'private@example.test',
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('private@example.test'),
        expect.any(Error),
        expect.any(Object),
      );
    },
  );

  it.each(['unique', 'sqlite-unique'])(
    'maps %s conflicts without exposing database values',
    async (kind) => {
      const response = await request(app.getHttpServer())
        .get(`/errors/${kind}`)
        .expect(409);
      expect(response.body.message).toBe(
        'A record with these values already exists',
      );
      expect(response.body.error).toBe('Conflict');
      expect(response.body).not.toHaveProperty('stack');
    },
  );

  it('preserves actionable validation errors without a server stack', async () => {
    const response = await request(app.getHttpServer())
      .get('/errors/validation')
      .expect(400);
    expect(response.body.message).toEqual(['title is required']);
    expect(response.body).not.toHaveProperty('stack');
  });
});
