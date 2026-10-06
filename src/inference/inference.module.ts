import { IncludedImageService } from './image.service';
import {
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { UsageModule } from '../usage/usage.module';
import {
  InferenceAdminController,
  InferenceController,
} from './inference.controller';
import { InferenceRepository } from './inference.repository';
import { InferenceService } from './inference.service';
@Module({
  imports: [BillingModule, UsageModule],
  controllers: [InferenceController, InferenceAdminController],
  providers: [InferenceRepository, InferenceService, IncludedImageService],
})
export class InferenceModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly inference: InferenceService) {}
  /** Settle reservations whose request died with a server (ADR 0082). */
  onModuleInit() {
    if (process.env.NODE_ENV !== 'test') this.inference.startSweeper();
  }
  onModuleDestroy() {
    this.inference.stopSweeper();
  }
}
