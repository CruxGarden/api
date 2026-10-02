import { SyncStorageModule } from '../sync/sync-storage.module';
import { BillingModule } from '../billing/billing.module';
import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AccountRepository } from './account.repository';
import { CommonModule } from '../common/common.module';
import { AuthorModule } from '../author/author.module';
import { CruxModule } from '../crux/crux.module';
@Module({
  imports: [
    CommonModule,
    AuthorModule,
    CruxModule,
    BillingModule,
    SyncStorageModule,
  ],
  controllers: [AccountController],
  providers: [AccountService, AccountRepository],
  exports: [AccountService, AccountRepository],
})
export class AccountModule {}
