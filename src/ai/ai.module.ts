import { Module, forwardRef } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { CruxModule } from '../crux/crux.module';
import { AttachmentModule } from '../attachment/attachment.module';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [forwardRef(() => CruxModule), forwardRef(() => AttachmentModule), forwardRef(() => AuthorModule)],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
