import {
  Module,
  forwardRef,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DomainsController } from './domains.controller';
import { PublishResolveController } from './publish-resolve.controller';
import { DomainsService } from './domains.service';
import { DomainsRepository } from './domains.repository';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [forwardRef(() => AuthorModule)],
  controllers: [DomainsController, PublishResolveController],
  providers: [DomainsService, DomainsRepository],
  exports: [DomainsService],
})
export class DomainsModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly domains: DomainsService) {}
  onModuleInit() {
    if (process.env.NODE_ENV !== 'test') this.domains.startScheduler();
  }
  onModuleDestroy() {
    this.domains.stopScheduler();
  }
}
