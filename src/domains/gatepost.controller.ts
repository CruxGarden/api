import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DomainsService } from './domains.service';

/**
 * The gatepost — the fixed-address redirector that answers a bare custom
 * domain and sends it to www (infra/gatepost) — asks here before issuing a
 * certificate for a hostname (Caddy `on_demand_tls { ask }`): 200 for a live
 * bare-domain row, 404 otherwise, so no stranger can point a domain at those
 * addresses and get a certificate minted. Public; rate-limited like the rest.
 */
@ApiExcludeController()
@Controller('publish/gatepost')
export class GatepostController {
  constructor(private readonly domains: DomainsService) {}

  @Get('ask')
  async ask(@Query('domain') domain: string): Promise<{ ok: true }> {
    if (!(await this.domains.isGatepostHost(domain ?? '')))
      throw new NotFoundException('Not a connected domain');
    return { ok: true };
  }
}
