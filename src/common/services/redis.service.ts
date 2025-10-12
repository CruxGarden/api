import { Injectable, OnModuleInit } from '@nestjs/common';
import { createClient } from 'redis';
import { LoggerService } from '../services/logger.service';

let redis: any;
let connected = false;

@Injectable()
export class RedisService implements OnModuleInit {
  private readonly logger: LoggerService;

  constructor(private readonly loggerService: LoggerService) {
    this.logger = this.loggerService.createChildLogger('RedisService');

    if (!redis) {
      redis = createClient({ url: process.env.REDIS_URL });
      redis.on('error', (err) => this.logger.error('Redis client error', err));
      redis.on('connect', () => this.logger.info('Redis client connected'));
      redis.on('disconnect', () =>
        this.logger.warn('Redis client disconnected'),
      );
    }
  }

  async onModuleInit() {
    await this.connect();
  }

  async connect() {
    if (connected) return;

    try {
      await redis.connect();
      connected = true;
      this.logger.debug('Redis connection established');
    } catch (error) {
      this.logger.error('Failed to connect to Redis', error);
      throw error;
    }
  }

  async set(key: string, val: string, expire?: number) {
    await this.connect();
    const opts = expire ? { EX: expire } : null;
    return redis.set(key, val, opts);
  }

  async get(key: string) {
    await this.connect();
    return redis.get(key) || null;
  }

  async del(key: string) {
    await this.connect();
    return redis.del(key);
  }

  async ping(): Promise<string> {
    await this.connect();
    return redis.ping();
  }

  async flushDb(): Promise<void> {
    await this.connect();
    return redis.flushDb();
  }

  async disconnect(): Promise<void> {
    if (connected) {
      await redis.disconnect();
      connected = false;
      this.logger.debug('Redis connection closed');
    }
  }
}
