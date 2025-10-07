import { Module, forwardRef } from '@nestjs/common';
import { ThemeService } from './theme.service';
import { ThemeController } from './theme.controller';
import { ThemeRepository } from './theme.repository';
import { AuthorModule } from '../author/author.module';
import { TagModule } from '../tag/tag.module';

@Module({
  imports: [forwardRef(() => AuthorModule), forwardRef(() => TagModule)],
  controllers: [ThemeController],
  providers: [ThemeService, ThemeRepository],
  exports: [ThemeService],
})
export class ThemeModule {}
