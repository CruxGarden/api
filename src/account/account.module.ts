import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AccountRepository } from './account.repository';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [AccountController],
  providers: [AccountService, AccountRepository],
  exports: [AccountService, AccountRepository],
})
export class AccountModule {}
