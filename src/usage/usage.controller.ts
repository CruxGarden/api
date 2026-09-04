import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { AuthorService } from '../author/author.service';
import { UsageRepository } from './usage.repository';
import { BillingService } from '../billing/billing.service';
import { isAdmin } from '../common/helpers/role-helpers';
import {
  UsageService,
  type AccountUsage,
  type CruxUsage,
  type PeriodView,
} from './usage.service';

@ApiTags('usage')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class UsageController {
  constructor(
    private readonly usageService: UsageService,
    private readonly authorService: AuthorService,
    private readonly usageRepo: UsageRepository,
    private readonly billing: BillingService,
  ) {}

  @Get('usage/me')
  @ApiOperation({
    summary:
      'Storage and bandwidth for the current billing period, with plan limits',
  })
  async me(@Req() req: AuthRequest): Promise<AccountUsage> {
    const author = await this.authorService.findByAccountId(req.account.id);
    if (!author)
      throw new NotFoundException('Author not found for this account');
    const planId = await this.billing.planIdFor(req.account.id);
    return this.usageService.forAuthor(
      author.id,
      { plan: planId },
      new Date(),
      req.account.id,
    );
  }

  @Get('cruxes/:id/usage')
  @ApiOperation({
    summary: 'Storage and bandwidth for one crux this billing period',
  })
  async crux(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<CruxUsage> {
    const author = await this.authorService.findByAccountId(req.account.id);
    if (!author)
      throw new NotFoundException('Author not found for this account');
    const owner = await this.usageRepo.authorForCrux(id);
    if (!owner.data) throw new NotFoundException('Crux not found');
    if (owner.data !== author.id) throw new ForbiddenException('Not your crux');
    return this.usageService.forCrux(id);
  }

  @Post('usage/ingest/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: ingest new CloudFront logs now' })
  async ingest(@Req() req: AuthRequest) {
    if (!isAdmin(req.account.role)) throw new ForbiddenException('Admins only');
    const source = this.usageService.s3LogSource();
    if (!source)
      return {
        files: 0,
        bytes: 0,
        requests: 0,
        skipped: 0,
        note: 'AWS_CLOUDFRONT_LOG_BUCKET not configured',
      };
    return this.usageService.ingest(source);
  }

  @Get('usage/periods')
  @ApiOperation({
    summary: 'Finalized billing periods for the current account (newest first)',
  })
  async periods(@Req() req: AuthRequest): Promise<PeriodView[]> {
    const author = await this.authorService.findByAccountId(req.account.id);
    if (!author)
      throw new NotFoundException('Author not found for this account');
    return this.usageService.periodsForAuthor(author.id);
  }

  @Get('usage/reconcile')
  @ApiOperation({
    summary: 'Admin: daily bandwidth reconciliation against CloudFront',
  })
  async reconciliation(@Req() req: AuthRequest) {
    if (!isAdmin(req.account.role)) throw new ForbiddenException('Admins only');
    return this.usageService.reconciliationHistory();
  }

  @Post('usage/reconcile/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: reconcile the last days now' })
  async reconcile(@Req() req: AuthRequest) {
    if (!isAdmin(req.account.role)) throw new ForbiddenException('Admins only');
    const metrics = this.usageService.edgeMetrics();
    if (!metrics)
      return {
        days: [],
        note: 'PUBLISH_DISTRIBUTION_ID / AWS keys not configured',
      };
    return { days: await this.usageService.reconcile(metrics) };
  }

  @Post('usage/periods/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin: finalize the previous billing period if grace has passed',
  })
  async closePeriods(@Req() req: AuthRequest) {
    if (!isAdmin(req.account.role)) throw new ForbiddenException('Admins only');
    return this.usageService.closePeriods();
  }
}
