/**
 * Emit the OpenAPI document to openapi.json WITHOUT starting the server.
 *
 * This is the app↔api contract source: the app generates its wire types from
 * this file (see app/src/api/generated/) instead of hand-maintaining copies.
 *
 *   npm run openapi          # writes ./openapi.json
 *
 * Requires DATABASE_URL/REDIS_URL to be resolvable only at module-init level —
 * services are constructed but nothing connects until a request arrives, so a
 * local .env works fine.
 */
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { version } from '../package.json';

async function emit() {
  const app = await NestFactory.create(AppModule, { logger: false });

  const options = new DocumentBuilder()
    .setTitle('Crux Garden API')
    .setVersion(version)
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, options);
  const out = join(__dirname, '..', 'openapi.json');
  writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`OpenAPI document written to ${out} (${Object.keys(document.paths).length} paths)`);
  await app.close();
  process.exit(0);
}

emit().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to emit OpenAPI document:', err);
  process.exit(1);
});
