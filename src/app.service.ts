import { Injectable } from '@nestjs/common';
import { DbService } from './common/services/db.service';
import { RedisService } from './common/services/redis.service';
import { HealthStatus, ServiceHealth } from './common/types/interfaces';
import { HealthStatusType, ServiceHealthType } from './common/types/enums';
import { version } from '../package.json';

@Injectable()
export class AppService {
  constructor(
    private readonly dbService: DbService,
    private readonly redisService: RedisService,
  ) {}

  async health(): Promise<HealthStatus> {
    const [database, redis] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    const overallStatus =
      database.status === ServiceHealthType.DOWN ||
      redis.status === ServiceHealthType.DOWN
        ? HealthStatusType.UNHEALTHY
        : database.status === ServiceHealthType.UP &&
            redis.status === ServiceHealthType.UP
          ? HealthStatusType.HEALTHY
          : HealthStatusType.DEGRADED;

    return {
      status: overallStatus,
      version,
      timestamp: new Date().toISOString(),
      services: {
        database,
        redis,
      },
    };
  }

  private async checkDatabase(): Promise<ServiceHealth> {
    const start = Date.now();
    const statusQuery = 'SELECT 1';
    try {
      await this.dbService.query().raw(statusQuery);
      return {
        status: ServiceHealthType.UP,
        responseTime: Date.now() - start,
      };
    } catch (error) {
      return {
        status: ServiceHealthType.DOWN,
        responseTime: Date.now() - start,
        error: error.message,
      };
    }
  }

  private async checkRedis(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      await this.redisService.ping();
      return {
        status: ServiceHealthType.UP,
        responseTime: Date.now() - start,
      };
    } catch (error) {
      return {
        status: ServiceHealthType.DOWN,
        responseTime: Date.now() - start,
        error: error.message,
      };
    }
  }
}
