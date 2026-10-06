import express = require('express');
import multer = require('multer');
import request = require('supertest');
import { request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { receivePublishUpload, publishUploadLimits } from './upload-storage';
import { MAX_PUBLISH_FILES } from '../types/constants';
import {
  Controller,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PublishUploadInterceptor } from './upload.interceptor';

@Controller('publish')
class UploadBoundaryController {
  @Post()
  @UseInterceptors(PublishUploadInterceptor)
  publish(@UploadedFiles() files: Express.Multer.File[]) {
    return { count: files.length };
  }
}

it('the Nest upload boundary accepts files and returns client errors for malformed multipart requests', async () => {
  const module = await Test.createTestingModule({
    controllers: [UploadBoundaryController],
  }).compile();
  const app = module.createNestApplication();
  // Keep one listener for all requests. Reopening the server per Supertest
  // request can race connection teardown after a multipart refusal.
  await app.listen(0, '127.0.0.1');
  try {
    const endpoint = () => request(app.getHttpServer()).post('/publish');
    expect(
      (await endpoint().attach('files', Buffer.from('ok'), 'ok.txt')).body,
    ).toEqual({ count: 1 });
    const unexpected = await endpoint().attach(
      'unexpected',
      Buffer.from('x'),
      'x.txt',
    );
    expect(unexpected.status).toBe(400);
    expect(unexpected.body.message).toBe('Invalid publish upload.');
    const malformed = await endpoint()
      .set('Content-Type', 'multipart/form-data')
      .send('broken');
    expect(malformed.status).toBe(400);
    expect(malformed.body.message).toBe('Invalid multipart upload.');
    expect(
      (await endpoint().attach('files', Buffer.from('still ok'), 'ok.txt'))
        .body,
    ).toEqual({ count: 1 });
  } finally {
    await app.close();
  }
});

function server(maxBytes?: number) {
  const app = express();
  app.post(
    '/publish',
    (req, res, next) =>
      receivePublishUpload(req, res, maxBytes).then(() => next(), next),
    (req, res) => {
      res.json({ count: (req.files as Express.Multer.File[]).length });
    },
  );
  app.get('/health', (_req, res) => {
    res.sendStatus(200);
  });
  app.use(
    (
      error: multer.MulterError,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next; // Express identifies error middleware by all four parameters.
      res.status(400).json({ code: error.code });
    },
  );
  return app;
}
function upload(app: ReturnType<typeof server>, count: number) {
  const req = request(app).post('/publish');
  for (let i = 0; i < count; i++)
    req.attach('files', Buffer.from('x'), `file-${i}.txt`);
  return req;
}
describe('large tool multipart uploads', () => {
  it('accepts a complete GDevelop-sized tool', async () => {
    const res = await upload(server(), 7774);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(7774);
  }, 30000);
  it('rejects excess files without crashing during cleanup and still serves requests', async () => {
    const app = server();
    const res = await upload(app, MAX_PUBLISH_FILES + 1);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LIMIT_FILE_COUNT');
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await upload(app, 1)).status).toBe(200);
  }, 30000);
});

describe('publish byte budget', () => {
  it('bounds metadata fields independently of the file budget', async () => {
    const app = server(8);
    const repeated = await request(app)
      .post('/publish')
      .field('meta', '[]')
      .field('extra', 'x');
    expect(repeated.status).toBe(400);
    expect(repeated.body.code).toBe('LIMIT_FIELD_COUNT');
    const oversized = await request(app)
      .post('/publish')
      .field('meta', 'x'.repeat(publishUploadLimits.fieldSize + 1));
    expect(oversized.status).toBe(400);
    expect(oversized.body.code).toBe('LIMIT_FIELD_VALUE');
    expect((await upload(app, 1)).status).toBe(200);
  });

  it('rejects several individually small files when their combined size exceeds the budget', async () => {
    const app = server(8);
    const response = await request(app)
      .post('/publish')
      .attach('files', Buffer.alloc(5), 'one.txt')
      .attach('files', Buffer.alloc(4), 'two.txt');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('LIMIT_FILE_SIZE');
    expect((await upload(app, 1)).status).toBe(200);
  });

  it('accepts the exact budget and gives each concurrent request its own budget', async () => {
    const app = server(8);
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(app)
          .post('/publish')
          .attach('files', Buffer.alloc(4), 'one.txt')
          .attach('files', Buffer.alloc(4), 'two.txt'),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(responses.map((response) => response.body.count)).toEqual([2, 2, 2]);
  });

  it('refuses a chunked upload before the sender finishes the oversized part', async () => {
    const listener = server(8).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    const outgoing = httpRequest({
      hostname: '127.0.0.1',
      port: (listener.address() as AddressInfo).port,
      path: '/publish',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=budget' },
    });
    try {
      const closed = new Promise<void>((resolve) =>
        outgoing.once('close', resolve),
      );
      const response = new Promise<number>((resolve) =>
        outgoing.once('response', (response) => {
          expect(response.headers.connection).toBe('close');
          response.resume();
          resolve(response.statusCode!);
        }),
      );
      outgoing.on('error', () => {});
      outgoing.write(
        '--budget\r\nContent-Disposition: form-data; name="files"; filename="large.txt"\r\nContent-Type: text/plain\r\n\r\n123456789',
      );
      const status = await Promise.race([
        response,
        new Promise<number>((resolve) => {
          const timer = setTimeout(() => resolve(0), 1000);
          response.finally(() => clearTimeout(timer));
        }),
      ]);
      expect(status).toBe(400);
      await closed;
      expect((await request(listener).get('/health')).status).toBe(200);
    } finally {
      outgoing.destroy();
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
