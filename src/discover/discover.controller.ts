import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { DbService } from '../common/services/db.service';
import { DiscoverService } from './discover.service';

@ApiTags('discover')
@Controller('discover')
export class DiscoverController {
  constructor(
    private readonly discoverService: DiscoverService,
    private readonly dbService: DbService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Search discoverable cruxes or authors' })
  @ApiQuery({ name: 'q', required: false, description: 'Search term' })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['cruxes', 'authors'],
    description: 'Result type',
  })
  @ApiQuery({
    name: 'tag',
    required: false,
    isArray: true,
    description: 'Filter by tag (exact, multiple = AND)',
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['recent', 'alpha'],
    description: 'Sort order',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'perPage', required: false, type: Number })
  async discover(
    @Query('q') q?: string,
    @Query('type') type: 'cruxes' | 'authors' = 'cruxes',
    @Query('tag') tag?: string | string[],
    @Query('sort') sort: 'recent' | 'alpha' = 'recent',
    @Req() req?: Request,
    @Res({ passthrough: true }) res?: Response,
  ) {
    if (type === 'authors') {
      const query = this.discoverService.getAuthorsQuery({ q, sort });
      return this.dbService.paginate({ query, request: req, response: res });
    }

    const tags = tag ? (Array.isArray(tag) ? tag : [tag]) : undefined;
    const query = this.discoverService.getCruxesQuery({ q, tag: tags, sort });
    return this.dbService.paginate({ query, request: req, response: res });
  }

  @Get('tags')
  @ApiOperation({ summary: 'Popular tags across discoverable cruxes' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max tags (default 50)',
  })
  async tags(@Query('limit') limit?: string) {
    const n = limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50;
    const data = await this.discoverService.getPopularTags(n);
    return { data };
  }
}
