import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { LoggerService } from '../common/services/logger.service';
import { DomainsRepository, type CustomDomainRow } from './domains.repository';
import {
  type DnsVerifier,
  nodeDnsVerifier,
  normalizeHostname,
  verificationRecordName,
  norm,
} from './dns-verifier';
import { type EdgeProvider, edgeProviderFromEnv } from './edge-provider';
import { cruxIdFromPublishHost } from '../usage/cloudfront-logs';

/** What the client shows: the domain, its state, and the DNS records to create. */
export interface CustomDomainView {
  id: string;
  cruxId: string;
  hostname: string;
  status: CustomDomainRow['status'];
  error: string | null;
  records: { type: 'CNAME' | 'TXT'; name: string; value: string }[];
  created: string;
  updated: string;
}

/** A domain that is never verified is released after this long. */
const PENDING_TTL_DAYS = 7;

@Injectable()
export class DomainsService {
  private readonly logger: LoggerService;
  private readonly cnameTarget: string;
  private edge: EdgeProvider;
  private dns: DnsVerifier;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repo: DomainsRepository,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('DomainsService');
    this.cnameTarget = norm(
      process.env.PUBLISH_CNAME_TARGET || 'publish.crux.garden',
    );
    this.edge = edgeProviderFromEnv();
    this.dns = nodeDnsVerifier;
  }

  /**
   * Edge lookup: which crux serves this hostname? Read by the origin-request
   * function (GET /publish/resolve). A domain serves as soon as its tenant
   * exists (issuing) — the certificate lands on the same tenant.
   */
  async resolve(host: string): Promise<string | null> {
    const hostname = normalizeHostname(host);
    if (!hostname) return null;
    const r = await this.repo.findByHostname(hostname);
    const row = r.data;
    if (!row || (row.status !== 'active' && row.status !== 'issuing'))
      return null;
    return row.crux_id;
  }

  /**
   * Full edge answer for any viewer Host: the crux and whether its files still
   * sit under the legacy shared-bucket prefix (published before ADR 0011's
   * bucket-per-crux layout and not republished since). A `{cruxId}.publish…`
   * host is answered from the crux itself; anything else is a custom domain.
   * Unpublished or deleted cruxes resolve to nothing, whatever the host.
   */
  async resolveHost(
    host: string,
  ): Promise<{ cruxId: string; legacy: boolean } | null> {
    const hostname = normalizeHostname(host) ?? host.trim().toLowerCase();
    const cruxId =
      cruxIdFromPublishHost(hostname) ?? (await this.resolve(hostname));
    if (!cruxId) return null;
    const state = (await this.repo.publishState(cruxId)).data;
    if (!state?.published) return null;
    return { cruxId, legacy: state.layout !== 'bucket-per-crux' };
  }

  /** tests */
  useProviders(edge: EdgeProvider, dns: DnsVerifier): void {
    this.edge = edge;
    this.dns = dns;
  }

  view(row: CustomDomainRow): CustomDomainView {
    return {
      id: row.id,
      cruxId: row.crux_id,
      hostname: row.hostname,
      status: row.status,
      error: row.error,
      records: [
        { type: 'CNAME', name: row.hostname, value: this.cnameTarget },
        {
          type: 'TXT',
          name: verificationRecordName(row.hostname),
          value: `crux-verify=${row.token}`,
        },
      ],
      created: new Date(row.created).toISOString(),
      updated: new Date(row.updated).toISOString(),
    };
  }

  async listForCrux(cruxId: string): Promise<CustomDomainView[]> {
    const r = await this.repo.findByCrux(cruxId);
    if (r.error)
      throw new InternalServerErrorException('Could not list domains');
    return (r.data ?? []).map((row) => this.view(row));
  }

  async add(
    cruxId: string,
    authorId: string,
    input: string,
  ): Promise<CustomDomainView> {
    const hostname = normalizeHostname(input);
    if (!hostname)
      throw new BadRequestException(
        'Enter a subdomain like blog.example.com — it needs a CNAME record, so apex domains (example.com) are not supported yet; crux.garden names are not allowed',
      );
    // Only a live connection (issuing/active) owns a hostname; a stale claim
    // somebody never verified cannot block the real owner.
    const existing = await this.repo.findLiveByHostname(hostname);
    if (existing.data)
      throw new ConflictException('That domain is already connected to a crux');
    const token = randomBytes(16).toString('hex');
    const r = await this.repo.create({
      crux_id: cruxId,
      author_id: authorId,
      hostname,
      token,
    });
    if (r.error || !r.data)
      throw new InternalServerErrorException('Could not save the domain');
    this.logger.info('Custom domain added', { hostname, cruxId });
    return this.view(r.data);
  }

  async get(id: string): Promise<CustomDomainRow> {
    const r = await this.repo.findById(id);
    if (r.error || !r.data) throw new NotFoundException('Domain not found');
    return r.data;
  }

  /**
   * Check DNS; when both records are present, create the tenant + mapping and
   * move to `issuing`; when the tenant reports its certificate, `active`.
   */
  async verify(id: string): Promise<CustomDomainView> {
    let row = await this.get(id);
    if (row.status === 'active') return this.view(row);

    if (row.status === 'pending_dns' || row.status === 'failed') {
      const [cnames, txts] = await Promise.all([
        this.dns.cnameTargets(row.hostname),
        this.dns.txtValues(verificationRecordName(row.hostname)),
      ]);
      const cnameOk = cnames.map(norm).includes(this.cnameTarget);
      const txtOk = txts.some((v) => v.trim() === `crux-verify=${row.token}`);
      if (!cnameOk || !txtOk) {
        const missing = [!cnameOk && 'CNAME', !txtOk && 'TXT']
          .filter(Boolean)
          .join(' and ');
        const updated = await this.repo.update(id, {
          status: 'pending_dns',
          error: `Waiting for the ${missing} record`,
        });
        return this.view(updated.data ?? row);
      }
      try {
        // a retry after a failed issue must not leave the old tenant behind
        if (row.tenant_id)
          await this.edge.deleteTenant(row.tenant_id).catch(() => undefined);
        const tenant = await this.edge.createTenant(row.hostname, row.crux_id);
        const updated = await this.repo.update(id, {
          status: tenant.status === 'active' ? 'active' : 'issuing',
          tenant_id: tenant.tenantId,
          error: null,
        });
        row = updated.data ?? row;
        this.logger.info('Custom domain tenant created', {
          hostname: row.hostname,
          tenantId: tenant.tenantId,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Certificate request failed';
        const updated = await this.repo.update(id, {
          status: 'failed',
          error: message,
        });
        this.logger.error(
          `tenant creation failed for ${row.hostname}: ${message}`,
        );
        return this.view(updated.data ?? row);
      }
    }

    if (row.status === 'issuing' && row.tenant_id) {
      const status = await this.edge.tenantStatus(row.tenant_id);
      if (status !== 'issuing') {
        const updated = await this.repo.update(id, {
          status: status === 'active' ? 'active' : 'failed',
          error:
            status === 'failed' ? 'The certificate could not be issued' : null,
        });
        row = updated.data ?? row;
      }
    }
    return this.view(row);
  }

  async remove(id: string): Promise<void> {
    const row = await this.get(id);
    if (row.tenant_id) {
      try {
        await this.edge.deleteTenant(row.tenant_id);
      } catch (err) {
        this.logger.error(
          `tenant delete failed for ${row.hostname}: ${(err as Error).message}`,
        );
      }
    }
    const r = await this.repo.remove(id);
    if (r.error)
      throw new InternalServerErrorException('Could not remove the domain');
    this.logger.info('Custom domain removed', { hostname: row.hostname });
  }

  /** Unpublish/delete of a crux: drop its domains at the edge too. */
  async removeAllForCrux(cruxId: string): Promise<void> {
    const r = await this.repo.findByCrux(cruxId);
    for (const row of r.data ?? []) await this.remove(row.id).catch(() => {});
  }

  /** Advance issuing tenants without a client asking. */
  async pollIssuing(): Promise<number> {
    // unverified claims expire so nobody can squat a hostname forever
    await this.repo.expirePending(PENDING_TTL_DAYS);
    const r = await this.repo.findIssuing();
    let advanced = 0;
    for (const row of r.data ?? []) {
      const before = row.status;
      const v = await this.verify(row.id).catch(() => null);
      if (v && v.status !== before) advanced += 1;
    }
    return advanced;
  }

  startScheduler(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollIssuing(), intervalMs);
  }
  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
