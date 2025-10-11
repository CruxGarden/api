import { Module, forwardRef } from '@nestjs/common';
import { PathController } from './path.controller';
import { PathService } from './path.service';
import { PathRepository } from './path.repository';
import { CruxModule } from '../crux/crux.module';
import { AuthorModule } from '../author/author.module';
import { TagModule } from '../tag/tag.module';
import { HomeModule } from '../home/home.module';

@Module({
  imports: [
    forwardRef(() => CruxModule),
    forwardRef(() => AuthorModule),
    forwardRef(() => TagModule),
    forwardRef(() => HomeModule),
  ],
  controllers: [PathController],
  providers: [PathService, PathRepository],
  exports: [PathService],
})
export class PathModule {}
