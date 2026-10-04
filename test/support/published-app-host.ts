/** Test-only full API host. Real PostgreSQL schema/auth/Store/isolate; fixture email, Redis and object storage.
 * The app's browser acceptance supplies an actual template Project Folder. Never imported by production.
 */
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/common/services/db.service';
import { RedisService } from '../../src/common/services/redis.service';
import { EmailService } from '../../src/common/services/email.service';
import { StoreService as Files } from '../../src/common/services/store.service';
import { createRequestValidationPipe } from '../../src/common/validation/request-validation';
import { applyInjections } from '../../src/common/publish/publish-injections';
import Artifact from '../../src/artifact/entities/artifact.entity';
import { MockRedisService } from '../mocks/redis.mock';
import { MockEmailService } from '../mocks/email.mock';
import { postgresFixture } from './postgres';

async function main() {
  const folder = resolve(process.argv[2] || '');
  if (!process.argv[2] || process.env.NODE_ENV !== 'test')
    throw new Error('Test Project Folder required');
  const files = new Map<string, Buffer>();
  for (const file of [
    'index.html',
    'app.js',
    'style.css',
    'crux.js',
    'README.md',
  ])
    files.set(file, await readFile(join(folder, file)));
  for (const file of await readdir(join(folder, 'functions')))
    if (/^[a-zA-Z0-9._-]+\.js$/.test(file))
      files.set(
        'functions/' + file,
        await readFile(join(folder, 'functions', file)),
      );
  const fixture = await postgresFixture();
  let app;
  try {
    const db = fixture.db.query();
    const home = randomUUID(),
      owner = randomUUID(),
      author = randomUUID(),
      crux = randomUUID(),
      otherCrux = randomUUID();
    await db('homes').insert({
      id: home,
      name: 'Private Requests fixture',
      type: 'home',
      kind: 'garden',
      primary: true,
    });
    await db('accounts').insert({
      id: owner,
      email: 'owner@example.test',
      role: 'author',
      home_id: home,
    });
    await db('authors').insert({
      id: author,
      account_id: owner,
      username: 'fixture-owner',
      display_name: 'Fixture Owner',
      home_id: home,
    });
    await db('cruxes').insert(
      [crux, otherCrux].map((id) => ({
        id,
        author_id: author,
        home_id: home,
        slug: id,
        title: 'Private Requests',
        data: '',
        type: 'webapp',
        status: 'living',
        visibility: 'public',
        meta: {
          publishedAt: new Date().toISOString(),
          publishedVersion: 1,
          publishStorageId: id,
          publishLayout: 'shared',
        },
      })),
    );
    await db('artifacts').insert(
      [crux, otherCrux].flatMap((id) =>
        [...files].map(([path, bytes]) => ({
          id: randomUUID(),
          resource_id: id,
          resource_type: 'crux',
          author_id: author,
          home_id: home,
          type: 'artifact',
          kind: 'file',
          filename: path.split('/').at(-1),
          mime_type: path.endsWith('.html')
            ? 'text/html'
            : 'application/javascript',
          encoding: 'utf8',
          size: bytes.length,
          meta: { path, publishStorageId: id, publishLayout: 'shared' },
        })),
      ),
    );
    const redis = new MockRedisService(),
      email = new MockEmailService();
    await redis.set(
      'crux:auth:grant:id:fixture-owner-grant',
      'owner@example.test',
      3600,
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService)
      .useValue(fixture.db)
      .overrideProvider(RedisService)
      .useValue(redis)
      .overrideProvider(EmailService)
      .useValue(email)
      .overrideProvider(Files)
      .useValue({
        download: async ({ path }: { path: string }) => {
          const data = files.get(path.substring(path.indexOf('/') + 1));
          if (!data) throw new Error('Missing fixture publication file');
          return { data };
        },
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.enableCors({ origin: true });
    app.useGlobalPipes(createRequestValidationPipe());
    const artifact = {
      filename: 'index.html',
      mimeType: 'text/html',
    } as Artifact;
    const html = applyInjections(
      files.get('index.html')!,
      artifact,
      [artifact],
      'webapp',
      { cruxId: crux, apiBase: 'https://api.private-requests.test' },
    ).data;
    app.use((req, res, next) => {
      const url = new URL(req.url, 'http://fixture');
      if (url.pathname === '/__fixture/code') {
        const mail = email
          .getSentEmails()
          .filter((e) => e.email === url.searchParams.get('email'))
          .at(-1);
        res.json({ code: mail?.body.match(/pc_[A-Za-z0-9_-]+/)?.[0] || null });
        return;
      }
      if (url.pathname.startsWith('/__fixture/files/')) {
        const path = decodeURIComponent(
          url.pathname.slice('/__fixture/files/'.length),
        );
        const data = path === 'index.html' ? html : files.get(path);
        if (!data || path.startsWith('functions/')) {
          res.status(404).end();
          return;
        }
        res
          .type(
            path.endsWith('.html')
              ? 'html'
              : path.endsWith('.css')
                ? 'css'
                : 'js',
          )
          .send(data);
        return;
      }
      next();
    });
    await app.listen(0, '127.0.0.1');
    process.send?.({
      url: await app.getUrl(),
      crux,
      otherCrux,
      origin: `https://${crux}.publish.crux.garden`,
      ownerToken: jwt.sign(
        {
          id: owner,
          email: 'owner@example.test',
          role: 'author',
          grantId: 'fixture-owner-grant',
        },
        process.env.JWT_SECRET,
      ),
      author,
    });
    const close = async () => {
      await app.close();
      await fixture.close();
      process.exit(0);
    };
    process.once('SIGTERM', () => void close());
    process.once('disconnect', () => void close());
  } catch (error) {
    await app?.close();
    await fixture.close();
    throw error;
  }
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
