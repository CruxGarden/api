import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Req,
  Res,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { SyncService } from './sync.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

@Controller('sync')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  // --- Garden ---

  @Put('garden')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }),
  )
  async pushGarden(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthRequest,
  ) {
    const data = file?.buffer;
    if (!data) {
      throw new BadRequestException('No file uploaded');
    }
    return this.syncService.pushGarden(req.account.id, data);
  }

  @Get('garden')
  async pullGarden(@Req() req: AuthRequest, @Res() res: Response) {
    const data = await this.syncService.pullGarden(req.account.id);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="garden.zip"',
      'Content-Length': data.length.toString(),
    });
    res.send(data);
  }

  @Get('garden/status')
  async getGardenStatus(@Req() req: AuthRequest) {
    const status = await this.syncService.getGardenStatus(req.account.id);
    if (!status) {
      throw new NotFoundException('No garden backup found');
    }
    return status;
  }

  @Delete('garden')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteGarden(@Req() req: AuthRequest) {
    await this.syncService.deleteGarden(req.account.id);
  }

  // --- Crux ---

  @Put('crux/:cruxId')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }),
  )
  async pushCrux(
    @Param('cruxId', ParseUUIDPipe) cruxId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { slug?: string; title?: string },
    @Req() req: AuthRequest,
  ) {
    const data = file?.buffer;
    if (!data) {
      throw new BadRequestException('No file uploaded');
    }
    return this.syncService.pushCrux(req.account.id, cruxId, data, {
      slug: body.slug || cruxId,
      title: body.title || 'Untitled',
    });
  }

  @Get('crux')
  async listCruxes(@Req() req: AuthRequest) {
    return this.syncService.listCruxes(req.account.id);
  }

  @Get('crux/:cruxId')
  async pullCrux(
    @Param('cruxId', ParseUUIDPipe) cruxId: string,
    @Req() req: AuthRequest,
    @Res() res: Response,
  ) {
    const data = await this.syncService.pullCrux(req.account.id, cruxId);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${cruxId}.crux"`,
      'Content-Length': data.length.toString(),
    });
    res.send(data);
  }

  @Delete('crux/:cruxId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCrux(
    @Param('cruxId', ParseUUIDPipe) cruxId: string,
    @Req() req: AuthRequest,
  ) {
    await this.syncService.deleteCrux(req.account.id, cruxId);
  }
}
