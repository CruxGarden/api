import { Module, forwardRef } from '@nestjs/common';
import { ArtifactController } from './artifact.controller';
import { ArtifactService } from './artifact.service';
import { ArtifactRepository } from './artifact.repository';
import { AuthorModule } from '../author/author.module';
import { HomeModule } from '../home/home.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    CommonModule,
    forwardRef(() => AuthorModule),
    forwardRef(() => HomeModule),
  ],
  controllers: [ArtifactController],
  providers: [ArtifactService, ArtifactRepository],
  exports: [ArtifactService],
})
export class ArtifactModule {}
