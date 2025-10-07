import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthRequest } from '../common/types/interfaces';
import { TagService } from './tag.service';
import { UpdateTagDto } from './dto/update-tag.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { DbService } from '../common/services/db.service';
import { TagSwagger } from './tag.swagger';
import { LoggerService } from '../common/services/logger.service';
import { isAdmin } from '../common/helpers/role-helpers';
import { ResourceType } from '../common/types/enums';
import Tag from './entities/tag.entity';
import TagRaw from './entities/tag-raw.entity';

@Controller('tags')
@UseGuards(AuthGuard)
@TagSwagger.Controller()
export class TagController {
  private readonly logger: LoggerService;

  constructor(
    private readonly tagService: TagService,
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('TagController');
    this.logger.debug('TagController initialized');
  }

  async canManageTag(req: AuthRequest): Promise<void> {
    if (!isAdmin(req.account.role)) {
      throw new ForbiddenException('Admin access required');
    }
  }

  @Get()
  @TagSwagger.FindAll()
  async findAll(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Query('resourceType') resourceType?: ResourceType,
    @Query('search') search?: string,
    @Query('sort') sort: 'alpha' | 'count' = 'count',
    @Query('label') label?: string,
  ): Promise<Tag[]> {
    const query = this.tagService.findAllQuery(
      resourceType,
      search,
      sort,
      label,
    );
    return this.dbService.paginate<TagRaw, Tag>({
      model: Tag,
      query,
      request: req,
      response: res,
    }) as Promise<Tag[]>;
  }

  @Get(':tagKey')
  @TagSwagger.GetByKey()
  async getByKey(@Param('tagKey') tagKey: string): Promise<Tag> {
    return this.tagService.findByKey(tagKey);
  }

  @Patch(':tagKey')
  @TagSwagger.UpdateTag()
  async update(
    @Param('tagKey') tagKey: string,
    @Body() updateTagDto: UpdateTagDto,
    @Req() req: AuthRequest,
  ): Promise<Tag> {
    await this.canManageTag(req);
    return this.tagService.update(tagKey, updateTagDto);
  }

  @Delete(':tagKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TagSwagger.DeleteTag()
  async delete(
    @Param('tagKey') tagKey: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    await this.canManageTag(req);
    return this.tagService.delete(tagKey);
  }
}
