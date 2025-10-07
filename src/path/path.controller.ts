import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthRequest } from '../common/types/interfaces';
import { PathService } from './path.service';
import { CreatePathDto } from './dto/create-path.dto';
import { UpdatePathDto } from './dto/update-path.dto';
import { SyncMarkersDto } from './dto/sync-markers.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { DbService } from '../common/services/db.service';
import { AuthorService } from '../author/author.service';
import { PathSwagger } from './path.swagger';
import { LoggerService } from '../common/services/logger.service';
import { SyncTagsDto } from '../tag/dto/sync-tags.dto';
import Path from './entities/path.entity';
import PathRaw from './entities/path-raw.entity';
import Author from '../author/entities/author.entity';
import Tag from '../tag/entities/tag.entity';
import Marker from './entities/marker.entity';

@Controller('paths')
@UseGuards(AuthGuard)
@PathSwagger.Controller()
export class PathController {
  private readonly logger: LoggerService;

  constructor(
    private readonly authorService: AuthorService,
    private readonly pathService: PathService,
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('PathController');
    this.logger.debug('PathController initialized');
  }

  async canManagePath(pathKey: string, author: Author): Promise<boolean> {
    const path = await this.pathService.findByKey(pathKey);
    if (path.authorId !== author.id) {
      throw new ForbiddenException(
        'You do not have permission to manage this path',
      );
    }
    return true;
  }

  async getAuthor(req: AuthRequest): Promise<Author> {
    const author = await this.authorService.findByAccountId(req.account.id);
    if (!author) {
      throw new NotFoundException('Author not found for this account');
    }
    return author;
  }

  async getPathByKey(pathKey: string): Promise<Path> {
    const path = await this.pathService.findByKey(pathKey);
    if (!path) {
      throw new NotFoundException('Path not found');
    }
    return path;
  }

  @Get()
  @PathSwagger.FindAll()
  async findAll(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Path[]> {
    const query = this.pathService.findAllQuery();
    return this.dbService.paginate<PathRaw, Path>({
      model: Path,
      query,
      request: req,
      response: res,
    }) as Promise<Path[]>;
  }

  @Get(':pathKey')
  @PathSwagger.GetByKey()
  async getByKey(@Param('pathKey') pathKey: string): Promise<Path> {
    return this.pathService.findByKey(pathKey);
  }

  @Post()
  @PathSwagger.Create()
  async create(
    @Body() createPathDto: CreatePathDto,
    @Req() req: AuthRequest,
  ): Promise<Path> {
    const author = await this.getAuthor(req);
    createPathDto.authorId = author.id;
    return this.pathService.create(createPathDto);
  }

  @Patch(':pathKey')
  @PathSwagger.Update()
  async update(
    @Param('pathKey') pathKey: string,
    @Body() updatePathDto: UpdatePathDto,
    @Req() req: AuthRequest,
  ): Promise<Path> {
    const author = await this.getAuthor(req);
    await this.canManagePath(pathKey, author);
    return this.pathService.update(pathKey, updatePathDto);
  }

  @Delete(':pathKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @PathSwagger.Delete()
  async delete(
    @Param('pathKey') pathKey: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    const author = await this.getAuthor(req);
    await this.canManagePath(pathKey, author);
    return this.pathService.delete(pathKey);
  }

  /* path markers */

  @Get(':pathKey/markers')
  @PathSwagger.GetMarkers()
  async getMarkers(@Param('pathKey') pathKey: string): Promise<Marker[]> {
    return this.pathService.getMarkers(pathKey);
  }

  @Put(':pathKey/markers')
  @PathSwagger.SyncMarkers()
  async syncMarkers(
    @Param('pathKey') pathKey: string,
    @Body() syncMarkersDto: SyncMarkersDto,
    @Req() req: AuthRequest,
  ): Promise<Marker[]> {
    const author = await this.getAuthor(req);
    await this.canManagePath(pathKey, author);
    return this.pathService.syncMarkers(
      pathKey,
      syncMarkersDto.markers,
      author.id,
    );
  }

  /* ~path markers */

  /* path tags */

  @Get(':pathKey/tags')
  @PathSwagger.GetTags()
  async getTags(
    @Param('pathKey') pathKey: string,
    @Query('filter') filter?: string,
  ): Promise<Tag[]> {
    return this.pathService.getTags(pathKey, filter);
  }

  @Put(':pathKey/tags')
  @PathSwagger.SyncTags()
  async syncTags(
    @Param('pathKey') pathKey: string,
    @Body() syncTagsDto: SyncTagsDto,
    @Req() req: AuthRequest,
  ): Promise<Tag[]> {
    const author = await this.getAuthor(req);
    await this.canManagePath(pathKey, author);
    return this.pathService.syncTags(pathKey, syncTagsDto.labels, author.id);
  }

  /* ~path tags */
}
