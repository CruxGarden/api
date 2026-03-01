import { Module, forwardRef } from '@nestjs/common';
import { AuthorController } from './author.controller';
import { AuthorService } from './author.service';
import { AuthorRepository } from './author.repository';
import { CruxModule } from '../crux/crux.module';
import { AttachmentModule } from '../attachment/attachment.module';

@Module({
  imports: [forwardRef(() => CruxModule), AttachmentModule],
  controllers: [AuthorController],
  providers: [AuthorService, AuthorRepository],
  exports: [AuthorService, AuthorRepository],
})
export class AuthorModule {}
