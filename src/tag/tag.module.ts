import { Module, forwardRef } from '@nestjs/common';
import { TagService } from './tag.service';
import { TagRepository } from './tag.repository';
import { TagController } from './tag.controller';
import { AuthorModule } from '../author/author.module';
import { HomeModule } from '../home/home.module';

@Module({
  imports: [forwardRef(() => AuthorModule), forwardRef(() => HomeModule)],
  controllers: [TagController],
  providers: [TagService, TagRepository],
  exports: [TagService],
})
export class TagModule {}
