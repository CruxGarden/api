require('dotenv').config({ quiet: true });

import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { setupRedoc } from './redoc.middleware';
import { EnvValidator } from './common/validators/env.validator';
import { version } from '../package.json';

if (process.env.NODE_ENV === 'production') EnvValidator.validate();

const port = process.env.PORT || 10000;
const hostname = process.env.HOSTNAME || '0.0.0.0';
const API_VERSION = version;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Increase JSON body limit for large meta payloads (chat history)
  app.use(json({ limit: '5mb' }));

  // CORS — validate origins against crux.garden and per-crux publish subdomains.
  // No credentials: true — auth uses Bearer tokens, not cookies.
  const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const PUBLISH_SUBDOMAIN_RE = new RegExp(`^https://${UUID_PATTERN}\\.publish\\.crux\\.garden$`);
  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, etc.)
      if (!origin) return callback(null, true);
      // Development: allow all origins when CORS_ORIGIN is '*'
      if (process.env.CORS_ORIGIN === '*') return callback(null, true);
      // Production: allow crux.garden app and per-crux publish subdomains
      if (
        origin === 'https://crux.garden' ||
        origin === (process.env.CORS_ORIGIN || '') ||
        PUBLISH_SUBDOMAIN_RE.test(origin)
      ) {
        return callback(null, true);
      }
      callback(new Error('CORS blocked'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'api-version',
      'X-Anthropic-Key',
    ],
  });

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://fonts.googleapis.com',
          ],
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use((_, res, next) => {
    res.setHeader('API-Version', API_VERSION);
    next();
  });

  const options = new DocumentBuilder()
    .setTitle('Crux Garden API')
    .setDescription('Where Ideas Grow')
    .setVersion(API_VERSION)
    .build();

  const document = SwaggerModule.createDocument(app, options);
  SwaggerModule.setup('api', app, document);

  setupRedoc(app);

  await app.listen(port, hostname);
}
bootstrap();
