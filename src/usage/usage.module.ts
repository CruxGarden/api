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
import { BillingModule } from '../billing/billing.module';
import { LimitsService } from './limits.service';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [forwardRef(() => AuthorModule), BillingModule],
  controllers: [UsageController],
  providers: [
    UsageService,
    UsageRepository,
    LimitsService,
    NotificationsService,
  ],
  exports: [UsageService, LimitsService, NotificationsService],
})
export class UsageModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly usage: UsageService,
    private readonly notifications: NotificationsService,
  ) {}
  onModuleInit() {
    if (process.env.NODE_ENV !== 'test') {
      this.usage.startScheduler();
      this.notifications.startScheduler();
    }
  }
  onModuleDestroy() {
    this.usage.stopScheduler();
    this.notifications.stopScheduler();
  }
}
