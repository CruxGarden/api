import {
  Body,
  Controller,
  Delete,
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
import { IsString, MaxLength } from 'class-validator';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { AuthorService } from '../author/author.service';
import { DomainsRepository } from './domains.repository';
import { DomainsService, type CustomDomainView } from './domains.service';

export class AddDomainDto {
  @IsString()
  @MaxLength(253)
  hostname!: string;
}

@ApiTags('domains')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class DomainsController {
  constructor(
    private readonly domains: DomainsService,
    private readonly authorService: AuthorService,
    private readonly repo: DomainsRepository,
  ) {}

  private async ownedCrux(id: string, req: AuthRequest) {
    const author = await this.authorService.findByAccountId(req.account.id);
    if (!author)
      throw new NotFoundException('Author not found for this account');
    const owner = await this.repo.authorForCrux(id);
    if (!owner.data) throw new NotFoundException('Crux not found');
    if (owner.data !== author.id) throw new ForbiddenException('Not your crux');
    return { author };
  }

  private async ownedDomain(id: string, req: AuthRequest) {
    const author = await this.authorService.findByAccountId(req.account.id);
    if (!author)
      throw new NotFoundException('Author not found for this account');
    const row = await this.domains.get(id);
    if (row.author_id !== author.id)
      throw new ForbiddenException('Not your domain');
    return row;
  }

  @Get('cruxes/:id/domains')
  @ApiOperation({ summary: 'Custom domains connected to a crux' })
  async list(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<CustomDomainView[]> {
    await this.ownedCrux(id, req);
    return this.domains.listForCrux(id);
  }

  @Post('cruxes/:id/domains')
  @ApiOperation({
    summary: 'Connect a custom domain; returns the DNS records to create',
  })
  async add(
    @Param('id') id: string,
    @Body() dto: AddDomainDto,
    @Req() req: AuthRequest,
  ): Promise<CustomDomainView> {
    const { author } = await this.ownedCrux(id, req);
    return this.domains.add(id, author.id, dto.hostname);
  }

  @Post('domains/:id/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Check DNS and advance the domain (pending_dns → issuing → active)',
  })
  async verify(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<CustomDomainView> {
    await this.ownedDomain(id, req);
    return this.domains.verify(id);
  }

  @Delete('domains/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect a custom domain' })
  async remove(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<void> {
    await this.ownedDomain(id, req);
    await this.domains.remove(id);
  }
}
