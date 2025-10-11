import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { LoggerModule } from './common/services/logger.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggerService } from './common/services/logger.service';
import { ApiVersionGuard } from './common/guards/api-version.guard';
import { AuthModule } from './auth/auth.module';
import { AccountModule } from './account/account.module';
import { AuthorModule } from './author/author.module';
import { CruxModule } from './crux/crux.module';
import { DimensionModule } from './dimension/dimension.module';
import { PathModule } from './path/path.module';
import { TagModule } from './tag/tag.module';
import { ThemeModule } from './theme/theme.module';
import { HomeModule } from './home/home.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: parseInt(process.env.RATE_LIMIT_TTL || '60000', 10), // 1 minute
        limit: parseInt(process.env.RATE_LIMIT_MAX || '100', 10), // 100 requests per minute
      },
    ]),
    LoggerModule,
    CommonModule,
    AuthModule,
    AccountModule,
    AuthorModule,
    CruxModule,
    DimensionModule,
    PathModule,
    TagModule,
    ThemeModule,
    HomeModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ApiVersionGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useFactory: (loggerService: LoggerService) => {
        return new HttpExceptionFilter(loggerService);
      },
      inject: [LoggerService],
    },
  ],
})
export class AppModule {}
