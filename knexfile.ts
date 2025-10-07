import type { Knex } from 'knex';
import * as dotenv from 'dotenv';

dotenv.config({ quiet: true });

// Pool configuration with environment variable overrides
const poolConfig = {
  min: parseInt(process.env.DB_POOL_MIN || '2', 10),
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10),
  acquireTimeoutMillis: parseInt(
    process.env.DB_POOL_ACQUIRE_TIMEOUT || '60000',
    10,
  ),
  createTimeoutMillis: 30000,
  destroyTimeoutMillis: 5000,
  reapIntervalMillis: 1000,
  createRetryIntervalMillis: 200,
  propagateCreateError: false,
};

const config: { [key: string]: Knex.Config } = {
  development: {
    client: 'postgresql',
    connection: {
      connectionString: process.env.DATABASE_URL,
    },
    pool: poolConfig,
    migrations: {
      directory: './db/migrations',
      extension: 'ts',
    },
    seeds: {
      directory: './db/seeds',
    },
  },

  production: {
    client: 'postgresql',
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    },
    pool: poolConfig,
    migrations: {
      directory: './db/migrations',
      extension: 'ts',
    },
    seeds: {
      directory: './db/seeds',
    },
    acquireConnectionTimeout: poolConfig.acquireTimeoutMillis,
    asyncStackTraces: true,
  },
};

export default config;