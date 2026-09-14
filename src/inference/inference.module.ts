import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { InferenceController } from './inference.controller';
import { InferenceRepository } from './inference.repository';
import { InferenceService } from './inference.service';
@Module({
  imports: [BillingModule],
  controllers: [InferenceController],
  providers: [InferenceRepository, InferenceService],
})
export class InferenceModule {}
