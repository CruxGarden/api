import {
  Module,
  forwardRef,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { FunctionsController } from './functions.controller';
import { FunctionsService } from './functions.service';
import { FunctionsRepository } from './functions.repository';
import { CruxModule } from '../crux/crux.module';
import { StoreModule } from '../crux-store/crux-store.module';
import { AuthorModule } from '../author/author.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [
    forwardRef(() => CruxModule),
    forwardRef(() => StoreModule),
    forwardRef(() => AuthorModule),
    forwardRef(() => UsageModule),
  ],
  controllers: [FunctionsController],
  providers: [FunctionsService, FunctionsRepository],
  exports: [FunctionsService],
})
export class FunctionsModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly functions: FunctionsService) {}
  onModuleInit() {
    if (process.env.NODE_ENV !== 'test') this.functions.startScheduler();
  }
  onModuleDestroy() {
    this.functions.stopScheduler();
  }
}
