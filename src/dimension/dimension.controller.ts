import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { AuthRequest } from '../common/types/interfaces';
import { DimensionService } from './dimension.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { UpdateDimensionDto } from './dto/update-dimension.dto';
import { DimensionSwagger } from './dimension.swagger';
import { LoggerService } from '../common/services/logger.service';
import { AuthorService } from '../author/author.service';
import Author from '../author/entities/author.entity';
import Dimension from './entities/dimension.entity';

@Controller('dimensions')
@UseGuards(AuthGuard)
@DimensionSwagger.Controller()
export class DimensionController {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dimensionService: DimensionService,
    private readonly authorService: AuthorService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('DimensionController');
  }

  async canManageDimension(
    dimensionKey: string,
    author: Author,
  ): Promise<boolean> {
    const dimension = await this.dimensionService.findByKey(dimensionKey);
    if (dimension.authorId !== author.id) {
      throw new ForbiddenException(
        'You do not have permission to manage this dimension',
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

  @Get(':dimensionKey')
  @DimensionSwagger.GetByKey()
  async getByKey(
    @Param('dimensionKey') dimensionKey: string,
  ): Promise<Dimension> {
    return this.dimensionService.findByKey(dimensionKey);
  }

  @Patch(':dimensionKey')
  @DimensionSwagger.UpdateDimension()
  async update(
    @Param('dimensionKey') dimensionKey: string,
    @Body() updateDimensionDto: UpdateDimensionDto,
    @Req() req: AuthRequest,
  ): Promise<Dimension> {
    const author = await this.getAuthor(req);
    await this.canManageDimension(dimensionKey, author);
    return this.dimensionService.update(dimensionKey, updateDimensionDto);
  }

  @Delete(':dimensionKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @DimensionSwagger.DeleteDimension()
  async delete(
    @Param('dimensionKey') dimensionKey: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    const author = await this.getAuthor(req);
    await this.canManageDimension(dimensionKey, author);
    return this.dimensionService.delete(dimensionKey);
  }
}
