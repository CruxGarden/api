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

  // CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
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
