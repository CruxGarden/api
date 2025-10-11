import { Module, forwardRef } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { CommonModule } from '../common/common.module';
import { AccountModule } from '../account/account.module';
import { AuthorModule } from '../author/author.module';
import { HomeModule } from '../home/home.module';

@Module({
  imports: [
    CommonModule,
    AccountModule,
    AuthorModule,
    forwardRef(() => HomeModule),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
