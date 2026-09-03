import {
  Module,
  forwardRef,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';
import { UsageRepository } from './usage.repository';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [forwardRef(() => AuthorModule)],
  controllers: [UsageController],
  providers: [UsageService, UsageRepository],
  exports: [UsageService],
})
export class UsageModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly usage: UsageService) {}
  onModuleInit() {
    if (process.env.NODE_ENV !== 'test') this.usage.startScheduler();
  }
  onModuleDestroy() {
    this.usage.stopScheduler();
  }
}
