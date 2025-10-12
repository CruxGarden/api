import {
  Controller,
  Delete,
  Put,
  Param,
  Body,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { File } from 'multer';
import { AttachmentService } from './attachment.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { AttachmentSwagger } from './attachment.swagger';
import { LoggerService } from '../common/services/logger.service';
import { AuthorService } from '../author/author.service';
import { UpdateAttachmentDto } from './dto/update-attachment.dto';
import Attachment from './entities/attachment.entity';

@Controller('attachments')
@UseGuards(AuthGuard)
@AttachmentSwagger.Controller()
export class AttachmentController {
  private readonly logger: LoggerService;

  constructor(
    private readonly authorService: AuthorService,
    private readonly attachmentService: AttachmentService,
    // private readonly dbService: DbService,
    // private readonly homeService: HomeService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AttachmentController');
    this.logger.debug('AttachmentController initialized');
  }

  async canManageAttachment(
    attachmentKey: string,
    req: AuthRequest,
  ): Promise<void> {
    const attachment = await this.attachmentService.findByKey(attachmentKey);
    const author = await this.authorService.findByAccountId(req.account.id);
    if (!attachment || !author) {
      throw new NotFoundException('Attachment or Author not found');
    }
    if (attachment.authorId !== author.id) {
      throw new ForbiddenException(
        'You do not have permission to manage this attachment',
      );
    }
  }

  @Put(':attachmentKey')
  @AttachmentSwagger.Update()
  @UseInterceptors(FileInterceptor('file'))
  async update(
    @Param('attachmentKey') attachmentKey: string,
    @Body() updateDto: UpdateAttachmentDto,
    @UploadedFile() file: File,
    @Req() req: AuthRequest,
  ): Promise<Attachment> {
    await this.canManageAttachment(attachmentKey, req);
    return this.attachmentService.updateWithFile(
      attachmentKey,
      updateDto,
      file,
    );
  }

  @Delete(':attachmentKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AttachmentSwagger.Delete()
  async delete(
    @Param('attachmentKey') attachmentKey: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    await this.canManageAttachment(attachmentKey, req);
    return this.attachmentService.deleteWithFile(attachmentKey);
  }
}
