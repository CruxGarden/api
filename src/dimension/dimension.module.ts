import { Module, forwardRef } from '@nestjs/common';
import { DimensionController } from './dimension.controller';
import { DimensionService } from './dimension.service';
import { DimensionRepository } from './dimension.repository';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [forwardRef(() => AuthorModule)],
  controllers: [DimensionController],
  providers: [DimensionService, DimensionRepository],
  exports: [DimensionService],
})
export class DimensionModule {}
