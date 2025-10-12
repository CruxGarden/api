import { Module, forwardRef } from '@nestjs/common';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { AttachmentRepository } from './attachment.repository';
import { AuthorModule } from '../author/author.module';
import { HomeModule } from '../home/home.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    CommonModule,
    forwardRef(() => AuthorModule),
    forwardRef(() => HomeModule),
  ],
  controllers: [AttachmentController],
  providers: [AttachmentService, AttachmentRepository],
  exports: [AttachmentService],
})
export class AttachmentModule {}
