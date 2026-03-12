import { Module, forwardRef } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { CruxModule } from '../crux/crux.module';
import { ArtifactModule } from '../artifact/artifact.module';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [
    forwardRef(() => CruxModule),
    forwardRef(() => ArtifactModule),
    forwardRef(() => AuthorModule),
  ],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
