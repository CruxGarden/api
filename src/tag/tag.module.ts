import { Module, forwardRef } from '@nestjs/common';
import { TagService } from './tag.service';
import { TagRepository } from './tag.repository';
import { TagController } from './tag.controller';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [forwardRef(() => AuthorModule)],
  controllers: [TagController],
  providers: [TagService, TagRepository],
  exports: [TagService],
})
export class TagModule {}
