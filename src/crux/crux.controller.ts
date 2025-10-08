import {
  Controller,
  Get,
  Delete,
  Param,
  Post,
  Patch,
  Put,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
  Query,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthRequest } from '../common/types/interfaces';
import { CruxService } from './crux.service';
import { CreateCruxDto } from './dto/create-crux.dto';
import { UpdateCruxDto } from './dto/update-crux.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { DbService } from '../common/services/db.service';
import { CruxSwagger } from './crux.swagger';
import { AuthorService } from '../author/author.service';
import { CreateDimensionDto } from '../dimension/dto/create-dimension.dto';
import Crux from './entities/crux.entity';
import CruxRaw from './entities/crux-raw.entity';
import Author from '../author/entities/author.entity';
import Dimension from '../dimension/entities/dimension.entity';
import DimensionRaw from '../dimension/entities/dimension-raw.entity';
import { DimensionType } from '../common/types/enums';
import { SyncTagsDto } from '../tag/dto/sync-tags.dto';
import Tag from '../tag/entities/tag.entity';

@Controller('cruxes')
@UseGuards(AuthGuard)
@CruxSwagger.Controller()
export class CruxController {
  constructor(
    private readonly authorService: AuthorService,
    private readonly cruxService: CruxService,
    private readonly dbService: DbService,
  ) {}

  async canManageCrux(cruxKey: string, author: Author): Promise<boolean> {
    const crux = await this.cruxService.findByKey(cruxKey);
    if (crux.authorId !== author.id) {
      throw new ForbiddenException(
        'You do not have permission to manage this crux',
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

  async getCruxByKey(cruxKey: string): Promise<Crux> {
    const crux = await this.cruxService.findByKey(cruxKey);
    if (!crux) {
      throw new NotFoundException('Crux not found');
    }
    return crux;
  }

  @Get()
  @CruxSwagger.FindAll()
  async findAll(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Crux[]> {
    const query = this.cruxService.findAllQuery();
    return this.dbService.paginate<CruxRaw, Crux>({
      model: Crux,
      query,
      request: req,
      response: res,
    }) as Promise<Crux[]>;
  }

  @Get(':cruxKey')
  @CruxSwagger.GetByKey()
  async getByKey(@Param('cruxKey') cruxKey: string): Promise<Crux> {
    return this.cruxService.findByKey(cruxKey);
  }

  @Post()
  @CruxSwagger.Create()
  async create(
    @Body() createCruxDto: CreateCruxDto,
    @Req() req: AuthRequest,
  ): Promise<Crux> {
    const author = await this.getAuthor(req);
    createCruxDto.authorId = author.id;
    return this.cruxService.create(createCruxDto);
  }

  @Patch(':cruxKey')
  @CruxSwagger.Update()
  async update(
    @Param('cruxKey') cruxKey: string,
    @Body() updateCruxDto: UpdateCruxDto,
    @Req() req: AuthRequest,
  ): Promise<Crux> {
    const author = await this.getAuthor(req);
    await this.canManageCrux(cruxKey, author);
    return this.cruxService.update(cruxKey, updateCruxDto);
  }

  @Delete(':cruxKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CruxSwagger.Delete()
  async delete(
    @Param('cruxKey') cruxKey: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    const author = await this.getAuthor(req);
    await this.canManageCrux(cruxKey, author);
    return this.cruxService.delete(cruxKey);
  }

  /* crux dimensions */

  @Get(':cruxKey/dimensions')
  @CruxSwagger.GetDimensions()
  async getDimensions(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('cruxKey') cruxKey: string,
    @Query('type') type?: DimensionType,
  ): Promise<Dimension[]> {
    const sourceCrux = await this.getCruxByKey(cruxKey);
    const query = this.cruxService.getDimensionsQuery(sourceCrux.id, type);

    return this.dbService.paginate<DimensionRaw, Dimension>({
      model: Dimension,
      query,
      request: req,
      response: res,
    }) as Promise<Dimension[]>;
  }

  @Post(':cruxKey/dimensions')
  @CruxSwagger.CreateDimension()
  async createDimension(
    @Param('cruxKey') cruxKey: string,
    @Body() createDimensionDto: CreateDimensionDto,
    @Req() req: AuthRequest,
  ): Promise<Dimension> {
    const author = await this.getAuthor(req);
    await this.canManageCrux(cruxKey, author);
    createDimensionDto.authorId = author.id;
    return this.cruxService.createDimension(cruxKey, createDimensionDto);
  }

  /* ~crux dimensions */

  /* crux tags */

  @Get(':cruxKey/tags')
  @CruxSwagger.GetTags()
  async getTags(
    @Param('cruxKey') cruxKey: string,
    @Query('filter') filter?: string,
  ): Promise<Tag[]> {
    await this.getCruxByKey(cruxKey);
    return this.cruxService.getTags(cruxKey, filter);
  }

  @Put(':cruxKey/tags')
  @CruxSwagger.SyncTags()
  async syncTags(
    @Param('cruxKey') cruxKey: string,
    @Body() syncTagsDto: SyncTagsDto,
    @Req() req: AuthRequest,
  ): Promise<Tag[]> {
    const author = await this.getAuthor(req);
    await this.canManageCrux(cruxKey, author);
    return this.cruxService.syncTags(cruxKey, syncTagsDto.labels, author.id);
  }

  /* ~crux tags */
}
