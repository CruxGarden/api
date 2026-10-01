import { BillingOperationsRepository } from './operations.repository';
import { BillingOperationsService } from './operations.service';
import { BillingSimulationRepository } from './simulation.repository';
import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingRepository } from './billing.repository';

@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    BillingRepository,
    BillingSimulationRepository,
    BillingOperationsRepository,
    BillingOperationsService,
  ],
  exports: [BillingService],
})
export class BillingModule {}
