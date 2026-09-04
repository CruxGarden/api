import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { DbService } from '../common/services/db.service';
import { ExploreService } from './explore.service';

@ApiTags('explore')
@Controller('explore')
export class ExploreController {
  constructor(
    private readonly exploreService: ExploreService,
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
    name: 'kind',
    required: false,
    description: 'Crux kind: webapp, page, document, image, notes, mood',
  })
  @ApiQuery({
    name: 'author',
    required: false,
    description: 'Author username (exact)',
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['relevant', 'recent', 'newest', 'alpha'],
    description:
      'Sort order (relevant = best match, default when q is given; recent = last updated; newest = first published)',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'perPage', required: false, type: Number })
  async explore(
    @Query('q') q?: string,
    @Query('type') type: 'cruxes' | 'authors' = 'cruxes',
    @Query('tag') tag?: string | string[],
    @Query('sort') sort?: 'relevant' | 'recent' | 'newest' | 'alpha',
    @Query('kind') kind?: string,
    @Query('author') author?: string,
    @Req() req?: Request,
    @Res({ passthrough: true }) res?: Response,
  ) {
    if (type === 'authors') {
      const query = this.exploreService.getAuthorsQuery({
        q: q?.replace(/^@/, ''),
        sort: sort === 'alpha' ? 'alpha' : 'recent',
      });
      return this.dbService.paginate({ query, request: req, response: res });
    }

    const tags = tag ? (Array.isArray(tag) ? tag : [tag]) : undefined;
    const query = this.exploreService.getCruxesQuery({
      q,
      tag: tags,
      sort,
      kind: kind || undefined,
      author: author || undefined,
    });
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
  @ApiQuery({
    name: 'kind',
    required: false,
    description: 'Only tags on cruxes of this kind',
  })
  async tags(@Query('limit') limit?: string, @Query('kind') kind?: string) {
    const n = limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50;
    const data = await this.exploreService.getPopularTags(n, kind || undefined);
    return { data };
  }
}
