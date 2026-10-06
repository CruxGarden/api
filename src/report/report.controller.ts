import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthGuard } from '../common/guards/auth.guard';
import { DbService } from '../common/services/db.service';
import { AuthRequest } from '../common/types/interfaces';
import Takedown from '../crux/entities/takedown.entity';
import TakedownRaw from '../crux/entities/takedown-raw.entity';
import { CreateReportDto } from './dto/create-report.dto';
import { CreateTakedownDto } from './dto/create-takedown.dto';
import {
  REPORT_STATUSES,
  ReportStatus,
  UpdateReportDto,
} from './dto/update-report.dto';
import Report from './entities/report.entity';
import ReportRaw from './entities/report-raw.entity';
import { ReportService } from './report.service';
import { ReportSummary } from './report.repository';

/** Anyone may report a published creation; no account is asked for. */
@ApiTags('explore')
@Controller('explore/reports')
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Report a published creation' })
  async create(
    @Body() dto: CreateReportDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.reportService.create(dto, req.ip);
    return { ok: true };
  }
}

/** Host moderation: reports and takedowns. */
@ApiTags('admin')
@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
export class ReportAdminController {
  constructor(
    private readonly reportService: ReportService,
    private readonly dbService: DbService,
  ) {}

  @Get('reports')
  @ApiOperation({ summary: 'List reports, newest first' })
  @ApiQuery({ name: 'status', required: false, enum: REPORT_STATUSES })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'perPage', required: false, type: Number })
  async reports(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: string,
  ): Promise<Report[]> {
    if (status && !REPORT_STATUSES.includes(status as ReportStatus))
      throw new BadRequestException(
        `status must be one of: ${REPORT_STATUSES.join(', ')}`,
      );
    return this.dbService.paginate<ReportRaw, Report>({
      model: Report,
      query: this.reportService.findAllQuery(status as ReportStatus),
      request: req,
      response: res,
    }) as Promise<Report[]>;
  }

  @Get('reports/summary')
  @ApiOperation({
    summary:
      'Counts for the operator screen: open reports, reports closed in the last 30 days, takedowns in force',
  })
  async reportSummary(): Promise<ReportSummary> {
    return this.reportService.summary();
  }

  @Patch('reports/:id')
  @ApiOperation({ summary: 'Resolve, dismiss or reopen a report' })
  async updateReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReportDto,
    @Req() req: AuthRequest,
  ): Promise<Report> {
    return this.reportService.update(id, dto, req.account.id);
  }

  @Get('takedowns')
  @ApiOperation({ summary: 'List takedowns, newest first' })
  @ApiQuery({
    name: 'active',
    required: false,
    description: 'true = only takedowns still in force',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'perPage', required: false, type: Number })
  async takedowns(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Query('active') active?: string,
  ): Promise<Takedown[]> {
    return this.dbService.paginate<TakedownRaw, Takedown>({
      model: Takedown,
      query: this.reportService.findTakedownsQuery(active === 'true'),
      request: req,
      response: res,
    }) as Promise<Takedown[]>;
  }

  @Post('takedowns')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Take a crux down: unpublish it and refuse to publish that id again',
  })
  async takeDown(
    @Body() dto: CreateTakedownDto,
    @Req() req: AuthRequest,
  ): Promise<Takedown> {
    return this.reportService.takeDown(dto, req.account.id);
  }

  @Delete('takedowns/:cruxId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lift a takedown; the author may publish the crux again',
  })
  async liftTakedown(
    @Param('cruxId', ParseUUIDPipe) cruxId: string,
    @Req() req: AuthRequest,
  ): Promise<Takedown> {
    return this.reportService.liftTakedown(cruxId, req.account.id);
  }
}
