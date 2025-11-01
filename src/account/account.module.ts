import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AccountRepository } from './account.repository';
import { CommonModule } from '../common/common.module';
import { AuthorModule } from '../author/author.module';
import { CruxModule } from '../crux/crux.module';
import { ThemeModule } from '../theme/theme.module';

@Module({
  imports: [CommonModule, AuthorModule, CruxModule, ThemeModule],
  controllers: [AccountController],
  providers: [AccountService, AccountRepository],
  exports: [AccountService, AccountRepository],
})
export class AccountModule {}
