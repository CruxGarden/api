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
import {
  UsageService,
  type AccountUsage,
  type CruxUsage,
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
    return this.usageService.forAuthor(
      author.id,
      author.meta as Record<string, unknown>,
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
    if (req.account.role !== 'admin')
      throw new ForbiddenException('Admins only');
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
}
