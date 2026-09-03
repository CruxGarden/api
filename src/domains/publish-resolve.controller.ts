import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DomainsService } from './domains.service';

/**
 * Edge-facing: the origin-request function resolves a custom hostname to the
 * crux it serves. Authenticated by the publish origin secret (the same value
 * the function presents to the buckets), not by a user token.
 */
@ApiExcludeController()
@Controller('publish')
export class PublishResolveController {
  constructor(private readonly domains: DomainsService) {}

  @Get('resolve')
  async resolve(
    @Query('host') host: string,
    @Headers('x-crux-origin-secret') secret: string | undefined,
  ): Promise<{ cruxId: string }> {
    const expected = process.env.PUBLISH_ORIGIN_SECRET;
    if (!expected || secret !== expected)
      throw new UnauthorizedException('Bad origin secret');
    const cruxId = await this.domains.resolve(host ?? '');
    if (!cruxId) throw new NotFoundException('No crux for this host');
    return { cruxId };
  }
}
