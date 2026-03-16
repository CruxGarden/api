import {
  Controller,
  Get,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Patch,
  Body,
  NotFoundException,
  BadRequestException,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ForbiddenException,
  Query,
  Header,
  StreamableFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { AuthRequest } from '../common/types/interfaces';
import { PathPrefix, AuthorEmbed } from '../common/types/enums';
import { AuthorService } from './author.service';
import { CreateAuthorDto } from './dto/create-author.dto';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { DbService } from '../common/services/db.service';
import { AuthorSwagger } from './author.swagger';
import { LoggerService } from '../common/services/logger.service';
import { stripPathPrefix } from '../common/helpers/path-helpers';
import Author from './entities/author.entity';
import AuthorRaw from './entities/author-raw.entity';
import { CruxService } from '../crux/crux.service';
import Crux from '../crux/entities/crux.entity';
import CruxRaw from '../crux/entities/crux-raw.entity';

@Controller('authors')
@AuthorSwagger.Controller()
export class AuthorController {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly authorService: AuthorService,
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
    private readonly cruxService: CruxService,
  ) {
    this.logger = this.loggerService.createChildLogger('AuthorController');
  }

  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Resolve an identifier to an author — supports UUID, @username, or plain username */
  private async resolveAuthor(identifier: string): Promise<Author> {
    const { hasPrefix, value } = stripPathPrefix(identifier, PathPrefix.USERNAME);
    if (hasPrefix) {
      return this.authorService.findByUsername(value);
    }
    if (AuthorController.UUID_RE.test(identifier)) {
      return this.authorService.findById(identifier);
    }
    return this.authorService.findByUsername(identifier);
  }

  async canManageAuthor(id: string, req: AuthRequest): Promise<boolean> {
    const author = await this.authorService.findById(id);
    if (!author) {
      throw new NotFoundException('Author not found');
    }
    if (author.accountId !== req.account.id) {
      throw new ForbiddenException(
        'You do not have permission to manage this author',
      );
    }
    return true;
  }

  @Get('check-username')
  @UseGuards(AuthGuard)
  @AuthorSwagger.CheckUsername()
  async checkUsername(
    @Query('username') username: string,
    @Req() req: AuthRequest,
  ): Promise<{ available: boolean }> {
    const existingAuthor =
      await this.authorService.checkUsernameExists(username);

    // Username is available if not found, or if it belongs to the current user's author
    // Get the current user's author to compare
    let currentAuthor = null;
    try {
      currentAuthor = await this.authorService.findByAccountId(req.account.id);
    } catch {
      // No author for this account yet
    }

    const available =
      !existingAuthor ||
      (currentAuthor && existingAuthor.id === currentAuthor.id);
    return { available };
  }

  @Get()
  @UseGuards(AuthGuard)
  @AuthorSwagger.FindAll()
  async getAll(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Author[]> {
    const query = this.authorService.findAllQuery();
    return this.dbService.paginate<AuthorRaw, Author>({
      model: Author,
      query,
      request: req,
      response: res,
    }) as Promise<Author[]>;
  }

  @Get(':identifier')
  @AuthorSwagger.GetByIdentifier()
  async getByIdentifier(
    @Param('identifier') identifier: string,
    @Query('embed') embed?: AuthorEmbed,
  ): Promise<Author> {
    let author = await this.resolveAuthor(identifier);

    if (embed === AuthorEmbed.ROOT && author.rootId) {
      const rootCrux = await this.cruxService.findById(author.rootId);
      author.root = rootCrux;
    }

    return author;
  }

  @Post()
  @UseGuards(AuthGuard)
  @AuthorSwagger.Create()
  async create(
    @Body() createAuthorDto: CreateAuthorDto,
    @Req() req: AuthRequest,
  ): Promise<Author> {
    createAuthorDto.accountId = req.account.id;
    return this.authorService.create(createAuthorDto);
  }

  @Patch(':id')
  @UseGuards(AuthGuard)
  @AuthorSwagger.Update()
  async update(
    @Param('id') id: string,
    @Body() updateAuthorDto: UpdateAuthorDto,
    @Req() req: AuthRequest,
  ): Promise<Author> {
    await this.canManageAuthor(id, req);
    return this.authorService.update(id, updateAuthorDto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @AuthorSwagger.Delete()
  async delete(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    await this.canManageAuthor(id, req);
    return this.authorService.delete(id);
  }

  @Post(':id/avatar')
  @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadAvatar(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthRequest,
  ): Promise<Author> {
    await this.canManageAuthor(id, req);
    if (!file) {
      throw new BadRequestException('File is required');
    }
    if (!file.mimetype.startsWith('image/')) {
      throw new BadRequestException('File must be an image');
    }
    return this.authorService.uploadAvatar(id, file);
  }

  @Delete(':id/avatar')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async removeAvatar(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<Author> {
    await this.canManageAuthor(id, req);
    return this.authorService.removeAvatar(id);
  }

  @Get(':identifier/avatar')
  async getAvatar(
    @Param('identifier') identifier: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const author = await this.resolveAuthor(identifier);

    const file = await this.authorService.getAvatarArtifact(author.id);
    if (!file) {
      throw new NotFoundException('No avatar found');
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    return new StreamableFile(file.data);
  }

  @Get(':identifier/cruxes')
  async getPublicCruxes(
    @Param('identifier') identifier: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Crux[]> {
    const author = await this.resolveAuthor(identifier);

    const query = this.cruxService.findPublicByAuthorQuery(author.id);
    return this.dbService.paginate<CruxRaw, Crux>({
      model: Crux,
      query,
      request: req,
      response: res,
    }) as Promise<Crux[]>;
  }

  @Get(':identifier/cruxes/:slug')
  async getCruxBySlug(
    @Param('identifier') identifier: string,
    @Param('slug') slug: string,
  ) {
    // Get author by username (strip @ prefix if present)
    const author = await this.resolveAuthor(identifier);

    // Get crux by author ID and slug
    return this.cruxService.findByAuthorAndSlug(author.id, slug);
  }

  @Get(':identifier/graph')
  async getGraph(@Param('identifier') identifier: string) {
    // Get author by username or id
    const author = await this.resolveAuthor(identifier);

    // Get graph data for this author
    return this.authorService.getGraph(author.id);
  }

  /* Public artifact endpoints for display mode */

  @Get(':identifier/cruxes/:slug/artifacts')
  async getPublicArtifacts(
    @Param('identifier') identifier: string,
    @Param('slug') slug: string,
  ) {
    const crux = await this.resolvePublicCrux(identifier, slug);
    return this.cruxService.getPublishedArtifacts(crux.id);
  }

  @Get(':identifier/cruxes/:slug/artifacts/:artifactId/download')
  @Header('Cache-Control', 'no-cache')
  async downloadPublicArtifact(
    @Param('identifier') identifier: string,
    @Param('slug') slug: string,
    @Param('artifactId') artifactId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const crux = await this.resolvePublicCrux(identifier, slug);
    const file = await this.cruxService.downloadArtifact(crux.id, artifactId);

    if (!file) {
      throw new NotFoundException('Artifact file not found');
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    // Serve renderable types inline for display mode
    const inline =
      file.mimeType.startsWith('text/') ||
      file.mimeType.startsWith('image/') ||
      file.mimeType === 'application/javascript' ||
      file.mimeType === 'application/json';

    res.setHeader(
      'Content-Disposition',
      inline
        ? `inline; filename="${file.filename}"`
        : `attachment; filename="${file.filename}"`,
    );

    return new StreamableFile(file.data);
  }

  private async resolvePublicCrux(identifier: string, slugOrId: string) {
    const author = await this.resolveAuthor(identifier);

    // Accept UUID (for stable artifact URLs) or slug (for human-friendly URLs)
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        slugOrId,
      );
    const crux = isUuid
      ? await this.cruxService.findById(slugOrId)
      : await this.cruxService.findByAuthorAndSlug(author.id, slugOrId);

    if (crux.visibility === 'private') {
      throw new NotFoundException('Crux not found');
    }

    return crux;
  }
}
