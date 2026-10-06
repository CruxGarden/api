import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthorModule } from '../author/author.module';
import { DomainsModule } from '../domains/domains.module';
import { PublishedAuthController } from './published-auth.controller';
import { PublishedAuthService } from './published-auth.service';
import { VisitorAuthGuard } from './visitor-auth.guard';

@Module({
  imports: [AuthModule, AuthorModule, DomainsModule],
  controllers: [PublishedAuthController],
  providers: [PublishedAuthService, VisitorAuthGuard],
  exports: [PublishedAuthService, VisitorAuthGuard],
})
export class PublishedAuthModule {}
