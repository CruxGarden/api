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
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  HttpCode,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
  Query,
  Header,
  StreamableFile,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
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
import Dimension from '../dimension/entities/dimension.entity';
import DimensionRaw from '../dimension/entities/dimension-raw.entity';
import { DimensionType, DimensionEmbed } from '../common/types/enums';
import { SyncTagsDto } from '../tag/dto/sync-tags.dto';
import Tag from '../tag/entities/tag.entity';
import { HomeService } from '../home/home.service';
import { UploadArtifactDto } from '../artifact/dto/upload-artifact.dto';
import {
  MAX_ARTIFACT_SIZE,
  MAX_PUBLISH_SIZE,
  MAX_PUBLISH_FILES,
} from '../common/types/constants';
import Artifact from '../artifact/entities/artifact.entity';
import { publishUploadStorage } from '../common/publish/upload-storage';

@Controller('cruxes')
@UseGuards(AuthGuard)
@CruxSwagger.Controller()
export class CruxController {
  constructor(
    private readonly authorService: AuthorService,
    private readonly cruxService: CruxService,
    private readonly dbService: DbService,
    private readonly homeService: HomeService,
  ) {}

  private async ownedCrux(id: string, req: AuthRequest): Promise<Crux> {
    const author = await this.authorService.findByAccountId(req.account.id);
    return this.cruxService.findOwnedById(id, author.id);
  }

  @Get()
  @CruxSwagger.FindAll()
  async findAll(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Crux[]> {
    const author = await this.authorService.findByAccountId(req.account.id);
    const query = this.cruxService.findAllByAuthorQuery(author.id);
    return this.dbService.paginate<CruxRaw, Crux>({
      model: Crux,
      query,
      request: req,
      response: res,
    }) as Promise<Crux[]>;
  }

  @Get(':identifier')
  @CruxSwagger.GetByIdentifier()
  async getByIdentifier(
    @Param('identifier') identifier: string,
    @Req() req: AuthRequest,
  ): Promise<Crux> {
    const author = await this.authorService.findByAccountId(req.account.id);
    return this.cruxService.findOwnedByIdentifier(identifier, author.id);
  }

  @Post()
  @CruxSwagger.Create()
  async create(
    @Body() createCruxDto: CreateCruxDto,
    @Req() req: AuthRequest,
  ): Promise<Crux> {
    const author = await this.authorService.findByAccountId(req.account.id);
    const home = await this.homeService.primary();
    createCruxDto.authorId = author.id;
    createCruxDto.homeId = home.id;
    return this.cruxService.create(createCruxDto);
  }

  @Patch(':id')
  @CruxSwagger.Update()
  async update(
    @Param('id') id: string,
    @Body() updateCruxDto: UpdateCruxDto,
    @Req() req: AuthRequest,
  ): Promise<Crux> {
    const author = await this.authorService.findByAccountId(req.account.id);
    await this.cruxService.findOwnedById(id, author.id);
    return this.cruxService.update(id, updateCruxDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CruxSwagger.Delete()
  async delete(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    const author = await this.authorService.findByAccountId(req.account.id);
    await this.cruxService.findOwnedById(id, author.id);
    return this.cruxService.delete(id);
  }

  /* crux dimensions */

  @Get(':id/dimensions')
  @CruxSwagger.GetDimensions()
  async getDimensions(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Query('type') type?: DimensionType,
    @Query('embed') embed?: string,
  ): Promise<Dimension[]> {
    const sourceCrux = await this.ownedCrux(id, req);

    // Parse embed parameter (default: target only)
    let embedSource = false;
    let embedTarget = true;

    if (embed) {
      const embedValues = embed.split(',').map((v) => v.trim().toLowerCase());

      if (embedValues.includes(DimensionEmbed.NONE)) {
        embedSource = false;
        embedTarget = false;
      } else {
        embedSource = embedValues.includes(DimensionEmbed.SOURCE);
        embedTarget = embedValues.includes(DimensionEmbed.TARGET);
      }
    }

    const query = this.cruxService
      .getDimensionsQuery(sourceCrux.id, type, embedSource, embedTarget)
      .where('dimensions.author_id', sourceCrux.authorId)
      .whereIn(
        'dimensions.target_id',
        this.cruxService
          .findAllByAuthorQuery(sourceCrux.authorId)
          .clearSelect()
          .select('id'),
      );

    return this.dbService.paginate<DimensionRaw, Dimension>({
      model: Dimension,
      query,
      request: req,
      response: res,
    }) as Promise<Dimension[]>;
  }

  @Post(':id/dimensions')
  @CruxSwagger.CreateDimension()
  async createDimension(
    @Param('id') id: string,
    @Body() createDimensionDto: CreateDimensionDto,
    @Req() req: AuthRequest,
  ): Promise<Dimension> {
    const author = await this.authorService.findByAccountId(req.account.id);
    await this.cruxService.findOwnedById(id, author.id);
    await this.cruxService.findOwnedById(
      createDimensionDto.targetId,
      author.id,
    );
    const home = await this.homeService.primary();
    createDimensionDto.authorId = author.id;
    createDimensionDto.homeId = home.id;
    return this.cruxService.createDimension(id, createDimensionDto);
  }

  /* ~crux dimensions */

  /* crux tags */

  @Get(':id/tags')
  @CruxSwagger.GetTags()
  async getTags(
    @Param('id') id: string,
    @Req() req: AuthRequest,
    @Query('filter') filter?: string,
  ): Promise<Tag[]> {
    await this.ownedCrux(id, req);
    return this.cruxService.getTags(id, filter);
  }

  @Put(':id/tags')
  @CruxSwagger.SyncTags()
  async syncTags(
    @Param('id') id: string,
    @Body() syncTagsDto: SyncTagsDto,
    @Req() req: AuthRequest,
  ): Promise<Tag[]> {
    const author = await this.authorService.findByAccountId(req.account.id);
    await this.cruxService.findOwnedById(id, author.id);
    return this.cruxService.syncTags(id, syncTagsDto.labels, author.id);
  }

  /* ~crux tags */

  /* crux artifacts */

  @Get(':id/artifacts')
  @CruxSwagger.GetArtifacts()
  async getArtifacts(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<Artifact[]> {
    await this.ownedCrux(id, req);
    return this.cruxService.getArtifacts(id);
  }

  @Post(':id/artifacts')
  @CruxSwagger.CreateArtifact()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_ARTIFACT_SIZE, files: 1, fields: 10 },
    }),
  )
  async createArtifact(
    @Param('id') id: string,
    @Body() uploadDto: UploadArtifactDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthRequest,
  ): Promise<Artifact> {
    const author = await this.authorService.findByAccountId(req.account.id);
    await this.cruxService.findOwnedById(id, author.id);

    return this.cruxService.createArtifact(id, uploadDto, file, author.id);
  }

  @Get(':id/artifacts/:artifactId/download')
  @CruxSwagger.DownloadArtifact()
  @Header('Cache-Control', 'no-cache')
  async downloadArtifact(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    await this.ownedCrux(id, req);
    const file = await this.cruxService.downloadArtifact(id, artifactId);

    if (!file) {
      throw new NotFoundException('Artifact file not found');
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );

    return new StreamableFile(file.data);
  }

  /* ~crux artifacts */

  /* crux publishing */

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FilesInterceptor('files', MAX_PUBLISH_FILES, {
      storage: publishUploadStorage(),
      limits: { fileSize: MAX_PUBLISH_SIZE },
    }),
  )
  async publish(
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('meta') metaJson: string,
    @Req() req: AuthRequest,
  ): Promise<Crux> {
    const author = await this.authorService.findByAccountId(req.account.id);
    await this.cruxService.findOwnedById(id, author.id);

    const totalSize = (files || []).reduce((sum, f) => sum + f.size, 0);
    if (totalSize > MAX_PUBLISH_SIZE) {
      throw new PayloadTooLargeException(
        `Total publish size exceeds the ${MAX_PUBLISH_SIZE / 1024 / 1024}MB limit`,
      );
    }

    let fileMetas: Array<{ path?: string; type?: string; kind?: string }> = [];
    if (metaJson) {
      try {
        fileMetas = JSON.parse(metaJson);
      } catch {
        fileMetas = [];
      }
    }

    return this.cruxService.publishCrux(
      id,
      files || [],
      fileMetas,
      author.id,
      req.account.id,
    );
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  async unpublish(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<Crux> {
    const author = await this.authorService.findByAccountId(req.account.id);
    await this.cruxService.findOwnedById(id, author.id);
    return this.cruxService.unpublishCrux(id);
  }

  /* ~crux publishing */
}
