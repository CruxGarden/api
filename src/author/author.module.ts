import { Module, forwardRef } from '@nestjs/common';
import { AuthorController } from './author.controller';
import { AuthorService } from './author.service';
import { AuthorRepository } from './author.repository';
import { CruxModule } from '../crux/crux.module';
import { ArtifactModule } from '../artifact/artifact.module';

@Module({
  imports: [forwardRef(() => CruxModule), ArtifactModule],
  controllers: [AuthorController],
  providers: [AuthorService, AuthorRepository],
  exports: [AuthorService, AuthorRepository],
})
export class AuthorModule {}
