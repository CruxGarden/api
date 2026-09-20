import { Module, forwardRef } from '@nestjs/common';
import { StoreController } from './crux-store.controller';
import { StoreService } from './crux-store.service';
import { StoreRepository } from './crux-store.repository';
import { StoreWriteRateLimitGuard } from './store-write-rate-limit.guard';
import { CruxModule } from '../crux/crux.module';
import { AuthorModule } from '../author/author.module';
import { UsageModule } from '../usage/usage.module';
import { FunctionsModule } from '../functions/functions.module';

@Module({
  imports: [
    forwardRef(() => CruxModule),
    forwardRef(() => AuthorModule),
    UsageModule,
    forwardRef(() => FunctionsModule),
  ],
  controllers: [StoreController],
  providers: [StoreService, StoreRepository, StoreWriteRateLimitGuard],
  exports: [StoreService],
})
export class StoreModule {}
