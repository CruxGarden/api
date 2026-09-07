import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
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
  isApexDomain,
  pointsAt,
} from './dns-verifier';
import { BillingService } from '../billing/billing.service';
import { planById } from '../usage/plans';
import { OverLimitException } from '../usage/limits.service';
import { type EdgeProvider, edgeProviderFromEnv } from './edge-provider';
import { cruxIdFromPublishHost } from '../usage/cloudfront-logs';

/** What the client shows: the domain, its state, and the DNS records to create. */
export interface CustomDomainView {
  id: string;
  cruxId: string;
  hostname: string;
  status: CustomDomainRow['status'];
  error: string | null;
  /**
   * What to create at the DNS provider. A subdomain: CNAME to the gate. A bare
   * domain (the GitHub Pages shape): A/AAAA records to the gatepost — the fixed
   * addresses that redirect the apex to www — plus a CNAME for www to the gate;
   * ALIAS to the gate instead of A/AAAA when no gatepost is configured. Always
   * the TXT proof of ownership.
   */
  records: {
    type: 'A' | 'AAAA' | 'CNAME' | 'ALIAS' | 'TXT';
    name: string;
    value: string;
  }[];
  created: string;
  updated: string;
}

/** A domain that is never verified is released after this long. */
const PENDING_TTL_DAYS = 7;

@Injectable()
export class DomainsService {
  private readonly logger: LoggerService;
  private readonly cnameTarget: string;
  /** Fixed addresses of the apex redirector (APEX_REDIRECT_IPS); empty → ALIAS instructions. */
  private readonly gatepostIps: string[];
  private edge: EdgeProvider;
  private dns: DnsVerifier;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repo: DomainsRepository,
    loggerService: LoggerService,
    @Optional() private readonly billing?: BillingService,
  ) {
    this.logger = loggerService.createChildLogger('DomainsService');
    this.cnameTarget = norm(
      process.env.PUBLISH_CNAME_TARGET || 'publish.crux.garden',
    );
    this.gatepostIps = (process.env.APEX_REDIRECT_IPS || '')
      .split(',')
      .map((ip) => ip.trim().toLowerCase())
      .filter(Boolean);
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
    const row = await this.liveRow(hostname);
    return row?.crux_id ?? null;
  }

  /**
   * The live row that owns a hostname. A bare domain's row also owns
   * `www.<domain>` — that is where its tenant serves; the apex itself is
   * answered by the gatepost, which redirects to www.
   */
  private async liveRow(hostname: string): Promise<CustomDomainRow | null> {
    const direct = (await this.repo.findByHostname(hostname)).data;
    if (direct && (direct.status === 'active' || direct.status === 'issuing'))
      return direct;
    if (hostname.startsWith('www.')) {
      const apex = hostname.slice(4);
      if (isApexDomain(apex)) {
        const row = (await this.repo.findByHostname(apex)).data;
        if (row && (row.status === 'active' || row.status === 'issuing'))
          return row;
      }
    }
    return null;
  }

  /**
   * Whether the gatepost may issue a certificate for `host` and redirect it:
   * true for a live bare-domain row. Caddy asks this before every new cert.
   */
  async isGatepostHost(host: string): Promise<boolean> {
    const hostname = normalizeHostname(host);
    if (!hostname || !isApexDomain(hostname)) return false;
    const row = (await this.repo.findByHostname(hostname)).data;
    return !!row && (row.status === 'active' || row.status === 'issuing');
  }

  /** The hostname the tenant serves: www for a bare domain, the name itself otherwise. */
  static servedHost(hostname: string): string {
    return isApexDomain(hostname) ? `www.${hostname}` : hostname;
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
      records: this.recordsFor(row),
      created: new Date(row.created).toISOString(),
      updated: new Date(row.updated).toISOString(),
    };
  }

  private recordsFor(row: CustomDomainRow): CustomDomainView['records'] {
    const txt = {
      type: 'TXT' as const,
      name: verificationRecordName(row.hostname),
      value: `crux-verify=${row.token}`,
    };
    if (!isApexDomain(row.hostname)) {
      return [
        { type: 'CNAME', name: row.hostname, value: this.cnameTarget },
        txt,
      ];
    }
    const apex: CustomDomainView['records'] = this.gatepostIps.length
      ? this.gatepostIps.map((ip) => ({
          type: ip.includes(':') ? ('AAAA' as const) : ('A' as const),
          name: row.hostname,
          value: ip,
        }))
      : [{ type: 'ALIAS', name: row.hostname, value: this.cnameTarget }];
    return [
      ...apex,
      { type: 'CNAME', name: `www.${row.hostname}`, value: this.cnameTarget },
      txt,
    ];
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
    accountId?: string | null,
  ): Promise<CustomDomainView> {
    const hostname = normalizeHostname(input);
    if (!hostname)
      throw new BadRequestException(
        'Enter a domain you own, like example.com or blog.example.com (crux.garden names are not allowed)',
      );
    // Only a live connection (issuing/active) owns a hostname; a stale claim
    // somebody never verified cannot block the real owner.
    const existing = await this.repo.findLiveByHostname(hostname);
    if (existing.data)
      throw new ConflictException('That domain is already connected to a crux');
    // Plan limit: how many domains an account may have connected at once.
    // Each one is a CloudFront tenant we pay for; Free includes one.
    const planId = this.billing
      ? await this.billing.planIdFor(accountId)
      : 'free';
    const plan = planById(planId);
    const open = (await this.repo.countOpenByAuthor(authorId)).data ?? 0;
    if (open >= plan.customDomains) {
      const noun =
        plan.customDomains === 1 ? 'custom domain' : 'custom domains';
      throw new OverLimitException(
        `The ${plan.name} plan includes ${plan.customDomains} ${noun} and you have ${open} connected. Disconnect one, or upgrade your plan in Settings.`,
        { limit: plan.customDomains, used: open, planId, kind: 'domains' },
      );
    }
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
      const apex = isApexDomain(row.hostname);
      const [apexOk, wwwOk, txts] = await Promise.all([
        apex ? this.apexPointsHere(row.hostname) : Promise.resolve(true),
        pointsAt(
          this.dns,
          DomainsService.servedHost(row.hostname),
          this.cnameTarget,
        ),
        this.dns.txtValues(verificationRecordName(row.hostname)),
      ]);
      const txtOk = txts.some((v) => v.trim() === `crux-verify=${row.token}`);
      if (!apexOk || !wwwOk || !txtOk) {
        const missing = [
          !apexOk && (this.gatepostIps.length ? 'A' : 'ALIAS'),
          !wwwOk && (apex ? 'CNAME for www' : 'CNAME'),
          !txtOk && 'TXT',
        ]
          .filter(Boolean)
          .join(' and ');
        const updated = await this.repo.update(id, {
          status: 'pending_dns',
          error: `Waiting for the ${missing} record`,
        });
        return this.view(updated.data ?? row);
      }
      // The tenant's origin is the crux's own bucket (ADR 0011): a crux that is
      // unpublished, or still in the shared bucket, has nothing there to serve.
      const state = (await this.repo.publishState(row.crux_id)).data;
      const blocker = !state?.published
        ? 'Publish the crux first — the domain serves its published files'
        : state.layout !== 'bucket-per-crux'
          ? 'Republish the crux first — its files still sit in the shared bucket, and a custom domain serves from the crux’s own bucket'
          : null;
      if (blocker) {
        const updated = await this.repo.update(id, {
          status: 'failed',
          error: blocker,
        });
        return this.view(updated.data ?? row);
      }
      try {
        // a retry after a failed issue must not leave the old tenant behind
        if (row.tenant_id)
          await this.edge.deleteTenant(row.tenant_id).catch(() => undefined);
        const tenant = await this.edge.createTenant(
          DomainsService.servedHost(row.hostname),
          row.crux_id,
        );
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

  /**
   * A bare domain points here when its A/AAAA records are the gatepost's, or —
   * with no gatepost configured, or a provider that flattens — when it shares
   * an address with the gate.
   */
  private async apexPointsHere(hostname: string): Promise<boolean> {
    if (this.gatepostIps.length) {
      const mine = await this.dns.addresses(hostname);
      if (mine.length && mine.every((ip) => this.gatepostIps.includes(ip)))
        return true;
    }
    return pointsAt(this.dns, hostname, this.cnameTarget);
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
  /**
   * After a republish: the crux's own bucket has new files, but each custom
   * domain caches through its tenant. Best effort — a failed invalidation
   * only means stale HTML until its short cache expires.
   */
  async invalidateForCrux(
    cruxId: string,
    paths: string[] = ['/*'],
  ): Promise<void> {
    const rows = (await this.repo.findByCrux(cruxId)).data ?? [];
    for (const row of rows) {
      if (row.status !== 'active' || !row.tenant_id) continue;
      try {
        await this.edge.invalidateTenant(row.tenant_id, paths);
      } catch (err) {
        this.logger.error(
          `tenant invalidation failed for ${row.hostname}: ${(err as Error).message}`,
        );
      }
    }
  }

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
