import { Module, forwardRef } from '@nestjs/common';
import { FunctionsController } from './functions.controller';
import { FunctionsService } from './functions.service';
import { CruxModule } from '../crux/crux.module';
import { StoreModule } from '../crux-store/crux-store.module';
import { AuthorModule } from '../author/author.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [
    forwardRef(() => CruxModule),
    forwardRef(() => StoreModule),
    forwardRef(() => AuthorModule),
    forwardRef(() => UsageModule),
  ],
  controllers: [FunctionsController],
  providers: [FunctionsService],
  exports: [FunctionsService],
})
export class FunctionsModule {}
