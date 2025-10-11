import {
  Controller,
  ForbiddenException,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { AttachmentService } from './attachment.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { AttachmentSwagger } from './attachment.swagger';
import { LoggerService } from '../common/services/logger.service';
import { AuthorService } from '../author/author.service';

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

  // TODO: Implement CRUD endpoints
  // @Get()
  // @AttachmentSwagger.GetAll()
  // async getAll(...): Promise<Attachment[]> { }

  // @Get(':attachmentKey')
  // @AttachmentSwagger.GetByKey()
  // async getByKey(...): Promise<Attachment> { }

  // @Post()
  // @AttachmentSwagger.Create()
  // async create(...): Promise<Attachment> { }

  // @Patch(':attachmentKey')
  // @AttachmentSwagger.Update()
  // async update(...): Promise<Attachment> { }

  // @Delete(':attachmentKey')
  // @HttpCode(HttpStatus.NO_CONTENT)
  // @AttachmentSwagger.Delete()
  // async delete(...): Promise<null> { }
}
