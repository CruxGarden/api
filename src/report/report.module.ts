import { Module } from '@nestjs/common';
import { CruxModule } from '../crux/crux.module';
import { ReportAdminController, ReportController } from './report.controller';
import { ReportRepository } from './report.repository';
import { ReportService } from './report.service';

@Module({
  imports: [CruxModule],
  controllers: [ReportController, ReportAdminController],
  providers: [ReportService, ReportRepository],
})
export class ReportModule {}
