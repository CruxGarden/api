import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { DomainsService } from './domains.service';

/**
 * Edge-facing: the origin-request function resolves a viewer Host (custom
 * domain or {cruxId}.publish… subdomain) to the crux it serves and whether the
 * files are still under the legacy shared-bucket prefix. Authenticated by the publish origin secret (the same value
 * the function presents to the buckets), not by a user token.
 */
@ApiExcludeController()
@SkipThrottle() // called by the edge for every uncached custom-domain hit
@Controller('publish')
export class PublishResolveController {
  constructor(private readonly domains: DomainsService) {}

  @Get('resolve')
  async resolve(
    @Query('host') host: string,
    @Headers('x-crux-origin-secret') secret: string | undefined,
  ): Promise<{ cruxId: string; legacy: boolean }> {
    const expected = process.env.PUBLISH_ORIGIN_SECRET;
    if (!expected || !secret || !safeEqual(secret, expected))
      throw new UnauthorizedException('Bad origin secret');
    const found = await this.domains.resolveHost(host ?? '');
    if (!found) throw new NotFoundException('No crux for this host');
    return found;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
