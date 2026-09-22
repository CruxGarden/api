import express = require('express');
import multer = require('multer');
import request = require('supertest');
import { publishUploadStorage } from './upload-storage';
import { MAX_PUBLISH_FILES } from '../types/constants';

function server() {
  const app = express();
  app.post(
    '/publish',
    multer({ storage: publishUploadStorage() }).array(
      'files',
      MAX_PUBLISH_FILES,
    ),
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
    expect(res.body.code).toBe('LIMIT_UNEXPECTED_FILE');
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await upload(app, 1)).status).toBe(200);
  }, 30000);
});
