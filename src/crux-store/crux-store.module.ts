import { Module, forwardRef } from '@nestjs/common';
import { StoreController } from './crux-store.controller';
import { StoreService } from './crux-store.service';
import { StoreRepository } from './crux-store.repository';
import { CruxModule } from '../crux/crux.module';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [
    forwardRef(() => CruxModule),
    forwardRef(() => AuthorModule),
  ],
  controllers: [StoreController],
  providers: [StoreService, StoreRepository],
  exports: [StoreService],
})
export class StoreModule {}
