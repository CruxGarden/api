import { Module, forwardRef } from '@nestjs/common';
import { CruxController } from './crux.controller';
import { CruxService } from './crux.service';
import { CruxRepository } from './crux.repository';
import { AuthorModule } from '../author/author.module';
import { TagModule } from '../tag/tag.module';
import { DimensionModule } from '../dimension/dimension.module';
import { HomeModule } from '../home/home.module';
import { AttachmentModule } from '../attachment/attachment.module';

@Module({
  imports: [
    forwardRef(() => AuthorModule),
    forwardRef(() => TagModule),
    forwardRef(() => DimensionModule),
    forwardRef(() => HomeModule),
    forwardRef(() => AttachmentModule),
  ],
  controllers: [CruxController],
  providers: [CruxService, CruxRepository],
  exports: [CruxService],
})
export class CruxModule {}
