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
import { HomeService } from '../home/home.service';

@Controller('paths')
@UseGuards(AuthGuard)
@PathSwagger.Controller()
export class PathController {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly authorService: AuthorService,
    private readonly pathService: PathService,
    private readonly dbService: DbService,
    private readonly homeService: HomeService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('PathController');
  }

  async canManagePath(id: string, author: Author): Promise<boolean> {
    const path = await this.pathService.findById(id);
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

  @Get(':identifier')
  @PathSwagger.GetByKey()
  async getByIdentifier(
    @Param('identifier') identifier: string,
  ): Promise<Path> {
    return this.pathService.findByIdentifier(identifier);
  }

  @Post()
  @PathSwagger.Create()
  async create(
    @Body() createPathDto: CreatePathDto,
    @Req() req: AuthRequest,
  ): Promise<Path> {
    const author = await this.getAuthor(req);
    const home = await this.homeService.primary();
    createPathDto.authorId = author.id;
    createPathDto.homeId = home.id;
    return this.pathService.create(createPathDto);
  }

  @Patch(':id')
  @PathSwagger.Update()
  async update(
    @Param('id') id: string,
    @Body() updatePathDto: UpdatePathDto,
    @Req() req: AuthRequest,
  ): Promise<Path> {
    const author = await this.getAuthor(req);
    await this.canManagePath(id, author);
    return this.pathService.update(id, updatePathDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @PathSwagger.Delete()
  async delete(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    const author = await this.getAuthor(req);
    await this.canManagePath(id, author);
    return this.pathService.delete(id);
  }

  /* path markers */

  @Get(':id/markers')
  @PathSwagger.GetMarkers()
  async getMarkers(@Param('id') id: string): Promise<Marker[]> {
    return this.pathService.getMarkers(id);
  }

  @Put(':id/markers')
  @PathSwagger.SyncMarkers()
  async syncMarkers(
    @Param('id') id: string,
    @Body() syncMarkersDto: SyncMarkersDto,
    @Req() req: AuthRequest,
  ): Promise<Marker[]> {
    const author = await this.getAuthor(req);
    await this.canManagePath(id, author);
    return this.pathService.syncMarkers(
      id,
      syncMarkersDto.markers,
      author.id,
    );
  }

  /* ~path markers */

  /* path tags */

  @Get(':id/tags')
  @PathSwagger.GetTags()
  async getTags(
    @Param('id') id: string,
    @Query('filter') filter?: string,
  ): Promise<Tag[]> {
    return this.pathService.getTags(id, filter);
  }

  @Put(':id/tags')
  @PathSwagger.SyncTags()
  async syncTags(
    @Param('id') id: string,
    @Body() syncTagsDto: SyncTagsDto,
    @Req() req: AuthRequest,
  ): Promise<Tag[]> {
    const author = await this.getAuthor(req);
    await this.canManagePath(id, author);
    return this.pathService.syncTags(id, syncTagsDto.labels, author.id);
  }

  /* ~path tags */
}
