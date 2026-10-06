import {
  Body,
  Controller,
  Delete,
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
import { AdminGuard } from '../common/guards/admin.guard';
import { DbService } from '../common/services/db.service';
import { TagSwagger } from './tag.swagger';
import { LoggerService } from '../common/services/logger.service';
import { ResourceType } from '../common/types/enums';
import Tag from './entities/tag.entity';
import TagRaw from './entities/tag-raw.entity';

@Controller('tags')
@UseGuards(AuthGuard, AdminGuard)
@TagSwagger.Controller()
export class TagController {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly tagService: TagService,
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('TagController');
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

  @Get(':id')
  @TagSwagger.GetByKey()
  async getById(@Param('id') id: string): Promise<Tag> {
    return this.tagService.findById(id);
  }

  @Patch(':id')
  @TagSwagger.UpdateTag()
  async update(
    @Param('id') id: string,
    @Body() updateTagDto: UpdateTagDto,
  ): Promise<Tag> {
    return this.tagService.update(id, updateTagDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TagSwagger.DeleteTag()
  async delete(@Param('id') id: string): Promise<null> {
    return this.tagService.delete(id);
  }
}
