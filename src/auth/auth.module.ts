import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { CommonModule } from '../common/common.module';
import { AccountModule } from '../account/account.module';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [CommonModule, AccountModule, AuthorModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
