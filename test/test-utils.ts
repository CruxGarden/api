import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { DbService } from '../src/common/services/db.service';
import { RedisService } from '../src/common/services/redis.service';

// Load test environment variables
dotenv.config({ path: path.join(__dirname, '.env.test') });

/**
 * Creates a NestJS application instance for e2e testing
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();

  // Apply same configuration as production
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.init();
  return app;
}

/**
 * Cleans up test database by truncating all tables
 */
export async function cleanupTestDatabase(
  app: INestApplication,
): Promise<void> {
  const dbService = app.get(DbService);
  const knex = dbService.query();

  // Get all tables
  const tables = await knex
    .select('tablename')
    .from('pg_tables')
    .where('schemaname', 'public')
    .andWhereNot('tablename', 'like', 'knex%');

  // Truncate all tables except migrations
  for (const { tablename } of tables) {
    if (
      tablename !== 'knex_migrations' &&
      tablename !== 'knex_migrations_lock'
    ) {
      await knex.raw(`TRUNCATE TABLE "${tablename}" CASCADE`);
    }
  }
}

/**
 * Cleans up Redis test data
 */
export async function cleanupTestRedis(app: INestApplication): Promise<void> {
  const redisService = app.get(RedisService);
  await redisService.flushDb();
}

/**
 * Performs full cleanup of test environment
 */
export async function fullTestCleanup(app: INestApplication): Promise<void> {
  await cleanupTestDatabase(app);
  await cleanupTestRedis(app);
}

/**
 * Closes all connections and cleans up application
 */
export async function closeTestApp(app: INestApplication): Promise<void> {
  await app.close();
}

/**
 * Helper to extract tokens from response
 */
export function extractAuthTokens(response: any): {
  accessToken: string;
  refreshToken: string;
} {
  return {
    accessToken: response.body.accessToken,
    refreshToken: response.body.refreshToken,
  };
}

/**
 * Creates authorization header with Bearer token
 */
export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Generate random email for testing
 */
export function generateTestEmail(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `test-${timestamp}-${random}@example.com`;
}

/**
 * Generate random string for testing
 */
export function generateRandomString(length: number = 10): string {
  return Math.random()
    .toString(36)
    .substring(2, length + 2);
}

/**
 * Wait for specified milliseconds
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
