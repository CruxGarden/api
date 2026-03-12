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
import { ArtifactService } from './artifact.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { ArtifactSwagger } from './artifact.swagger';
import { LoggerService } from '../common/services/logger.service';
import { AuthorService } from '../author/author.service';
import { UpdateArtifactDto } from './dto/update-artifact.dto';
import Artifact from './entities/artifact.entity';

@Controller('artifacts')
@UseGuards(AuthGuard)
@ArtifactSwagger.Controller()
export class ArtifactController {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly authorService: AuthorService,
    private readonly artifactService: ArtifactService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('ArtifactController');
  }

  async canManageArtifact(id: string, req: AuthRequest): Promise<void> {
    const artifact = await this.artifactService.findById(id);
    const author = await this.authorService.findByAccountId(req.account.id);
    if (!artifact || !author) {
      throw new NotFoundException('Artifact or Author not found');
    }
    if (artifact.authorId !== author.id) {
      throw new ForbiddenException(
        'You do not have permission to manage this artifact',
      );
    }
  }

  @Put(':id')
  @ArtifactSwagger.Update()
  @UseInterceptors(FileInterceptor('file'))
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateArtifactDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthRequest,
  ): Promise<Artifact> {
    await this.canManageArtifact(id, req);
    return this.artifactService.updateWithFile(id, updateDto, file);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ArtifactSwagger.Delete()
  async delete(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    await this.canManageArtifact(id, req);
    return this.artifactService.deleteWithFile(id);
  }
}
