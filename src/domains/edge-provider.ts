import {
  CloudFrontClient,
  CreateDistributionTenantCommand,
  CreateInvalidationForDistributionTenantCommand,
  GetDistributionTenantCommand,
  GetDistributionTenantByDomainCommand,
  GetManagedCertificateDetailsCommand,
  ListDistributionTenantsCommand,
  UpdateDistributionTenantCommand,
  DeleteDistributionTenantCommand,
  type DistributionTenant,
} from '@aws-sdk/client-cloudfront';

/**
 * What the edge needs to serve a custom domain: a distribution tenant on the
 * multi-tenant "domains" distribution (ADR 0011, amended 2026-09-05). The
 * tenant carries the hostname, a CloudFront-managed certificate, and one
 * parameter — the crux's bucket name — which the multi-tenant distribution
 * substitutes into its origin domain (`{{bucket}}.s3-website-….amazonaws.com`). No
 * edge function is involved: the origin router on the standard distribution
 * serves only `*.publish.crux.garden`. Behind an interface so the flow can be
 * swapped for ACM + alternate domains without touching the domain lifecycle.
 */
export type TenantStatus = 'issuing' | 'active' | 'failed';

export interface EdgeProvider {
  createTenant(
    hostname: string,
    cruxId: string,
  ): Promise<{ tenantId: string; status: TenantStatus }>;
  tenantStatus(tenantId: string): Promise<TenantStatus>;
  /**
   * Stop serving and remove the tenant. CloudFront only deletes a DISABLED
   * tenant, and disabling propagates first — so this may answer 'disabling':
   * the domain is already dark, the delete must be retried later (the poller
   * sweeps). 'deleted' when it is gone (or never existed).
   */
  deleteTenant(tenantId: string): Promise<'deleted' | 'disabling'>;
  /** Drop the tenant's cached objects after a republish (best effort). */
  invalidateTenant(tenantId: string, paths: string[]): Promise<void>;
  /**
   * Every tenant we own at the edge. The sweep compares this with the rows
   * that are still connected: a tenant nobody claims is an orphan (a delete
   * that never finished, a row lost to a bug) and gets removed — so what the
   * edge serves is always what the garden says is connected.
   */
  listTenants(): Promise<EdgeTenant[]>;
}

export interface EdgeTenant {
  tenantId: string;
  hostname: string;
  enabled: boolean;
}

export class MockEdgeProvider implements EdgeProvider {
  tenants = new Map<
    string,
    { hostname: string; cruxId: string; checks: number; enabled: boolean }
  >();
  /** how many status checks before a tenant reports active */
  activeAfterChecks = 1;
  /** Mimic CloudFront: the first delete only disables, the next one deletes. */
  deleteNeedsTwoSteps = false;
  private n = 0;
  async createTenant(hostname: string, cruxId: string) {
    // Like the real provider: a tenant that already exists for this hostname
    // is reused (re-enabled, re-pointed) rather than fought over.
    for (const [id, t] of this.tenants) {
      if (t.hostname === hostname) {
        t.cruxId = cruxId;
        t.enabled = true;
        t.checks = 0;
        return { tenantId: id, status: 'issuing' as const };
      }
    }
    const tenantId = `tenant-${++this.n}`;
    this.tenants.set(tenantId, { hostname, cruxId, checks: 0, enabled: true });
    return { tenantId, status: 'issuing' as const };
  }
  async tenantStatus(tenantId: string): Promise<TenantStatus> {
    const t = this.tenants.get(tenantId);
    if (!t) return 'failed';
    t.checks += 1;
    return t.checks >= this.activeAfterChecks ? 'active' : 'issuing';
  }
  async deleteTenant(tenantId: string): Promise<'deleted' | 'disabling'> {
    const t = this.tenants.get(tenantId);
    if (!t) return 'deleted';
    if (this.deleteNeedsTwoSteps && t.enabled) {
      t.enabled = false;
      return 'disabling';
    }
    this.tenants.delete(tenantId);
    return 'deleted';
  }
  invalidations: { tenantId: string; paths: string[] }[] = [];
  async invalidateTenant(tenantId: string, paths: string[]) {
    this.invalidations.push({ tenantId, paths });
  }
  async listTenants(): Promise<EdgeTenant[]> {
    return [...this.tenants].map(([tenantId, t]) => ({
      tenantId,
      hostname: t.hostname,
      enabled: t.enabled,
    }));
  }
}

export interface CloudFrontEdgeConfig {
  region: string;
  /** The standard distribution (wildcard `*.publish.crux.garden`, origin router). */
  distributionId: string;
  /** The multi-tenant distribution tenants attach to; falls back to distributionId. */
  tenantDistributionId?: string;
  connectionGroupId?: string;
  /** Bucket name prefix (PUBLISH_BUCKET_PREFIX), default `crux-`. */
  bucketPrefix?: string;
}

/**
 * The parameter the multi-tenant distribution substitutes into its origin
 * domain (`{{bucket}}.s3-website-<region>.amazonaws.com`). Its value is the
 * crux's whole bucket name, so the distribution never has to know the prefix.
 */
export const TENANT_BUCKET_PARAMETER = 'bucket';

/** CloudFront SaaS Manager tenant. Needs live validation (see ADR 0011). */
export class CloudFrontEdgeProvider implements EdgeProvider {
  constructor(
    private readonly cf: CloudFrontClient,
    private readonly cfg: CloudFrontEdgeConfig,
  ) {}

  async createTenant(hostname: string, cruxId: string) {
    const bucket = `${this.cfg.bucketPrefix ?? 'crux-'}${cruxId.toLowerCase()}`;
    // A tenant may already exist for this hostname: disconnected but not yet
    // deleted, or the same domain reconnected to another crux. Reuse it —
    // re-enable, re-point — instead of colliding on CNAMEAlreadyExists.
    const existing = await this.findByDomain(hostname);
    if (existing) {
      const tenant = existing.tenant;
      const hasCert = !!tenant.Customizations?.Certificate?.Arn;
      const send = (requestCert: boolean) =>
        this.cf.send(
          new UpdateDistributionTenantCommand({
            Id: tenant.Id,
            IfMatch: existing.etag,
            Domains: [{ Domain: hostname }],
            Parameters: [{ Name: TENANT_BUCKET_PARAMETER, Value: bucket }],
            ConnectionGroupId:
              tenant.ConnectionGroupId ?? this.cfg.connectionGroupId,
            Customizations: tenant.Customizations,
            Enabled: true,
            ...(requestCert
              ? {
                  ManagedCertificateRequest: {
                    ValidationTokenHost: 'cloudfront' as const,
                  },
                }
              : {}),
          }),
        );
      let updated;
      try {
        updated = await send(!hasCert);
      } catch (err) {
        // "only one pending certificate request" — one is already in flight
        if (!hasCert && /pending/i.test((err as Error).message))
          updated = await send(false);
        else throw err;
      }
      return {
        tenantId: tenant.Id as string,
        status: tenantState(updated.DistributionTenant),
      };
    }
    const res = await this.cf.send(
      new CreateDistributionTenantCommand({
        DistributionId:
          this.cfg.tenantDistributionId ?? this.cfg.distributionId,
        Name: `crux-${cruxId}-${hostname.replace(/[^a-z0-9]/g, '-')}`.slice(
          0,
          128,
        ),
        Domains: [{ Domain: hostname }],
        ConnectionGroupId: this.cfg.connectionGroupId,
        // → origin domain <bucket>.s3-website-<region>.amazonaws.com
        Parameters: [{ Name: TENANT_BUCKET_PARAMETER, Value: bucket }],
        // CloudFront-managed certificate: validation rides on the CNAME the user already created
        ManagedCertificateRequest: { ValidationTokenHost: 'cloudfront' },
        Tags: { Items: [{ Key: 'crux-garden:crux', Value: cruxId }] },
        Enabled: true,
      }),
    );
    const tenantId = res.DistributionTenant?.Id;
    if (!tenantId) throw new Error('CloudFront did not return a tenant id');
    return { tenantId, status: tenantState(res.DistributionTenant) };
  }

  async tenantStatus(tenantId: string): Promise<TenantStatus> {
    const res = await this.cf.send(
      new GetDistributionTenantCommand({ Identifier: tenantId }),
    );
    const tenant = res.DistributionTenant;
    const state = tenantState(tenant);
    if (
      state !== 'issuing' ||
      !tenant ||
      tenant.Customizations?.Certificate?.Arn
    ) {
      return state;
    }
    // The managed certificate is requested at creation, but once ACM has
    // issued it CloudFront does not attach it to the tenant by itself: the
    // domain sits at `inactive` with an unused certificate (5ws.zacos.tech,
    // 2026-09-07). Attaching it is what turns the domain on.
    const cert = await this.cf.send(
      new GetManagedCertificateDetailsCommand({ Identifier: tenantId }),
    );
    const details = cert.ManagedCertificateDetails;
    if (details?.CertificateStatus !== 'issued' || !details.CertificateArn) {
      return state;
    }
    const updated = await this.cf.send(
      new UpdateDistributionTenantCommand({
        Id: tenantId,
        IfMatch: res.ETag,
        Domains: tenant.Domains?.map((d) => ({ Domain: d.Domain })),
        Parameters: tenant.Parameters,
        ConnectionGroupId: tenant.ConnectionGroupId,
        Enabled: tenant.Enabled ?? true,
        Customizations: {
          ...(tenant.Customizations ?? {}),
          Certificate: { Arn: details.CertificateArn },
        },
      }),
    );
    return tenantState(updated.DistributionTenant);
  }

  async deleteTenant(tenantId: string): Promise<'deleted' | 'disabling'> {
    let res;
    try {
      res = await this.cf.send(
        new GetDistributionTenantCommand({ Identifier: tenantId }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'EntityNotFound')
        return 'deleted';
      throw err;
    }
    const tenant = res.DistributionTenant;
    let etag = res.ETag;
    if (tenant?.Enabled) {
      // Dark first: the domain stops serving now, whatever the delete does.
      const off = await this.cf.send(
        new UpdateDistributionTenantCommand({
          Id: tenantId,
          IfMatch: etag,
          Domains: tenant.Domains?.map((d) => ({ Domain: d.Domain })),
          Parameters: tenant.Parameters,
          ConnectionGroupId: tenant.ConnectionGroupId,
          Customizations: tenant.Customizations,
          Enabled: false,
        }),
      );
      etag = off.ETag;
    }
    try {
      await this.cf.send(
        new DeleteDistributionTenantCommand({ Id: tenantId, IfMatch: etag }),
      );
      return 'deleted';
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (name === 'EntityNotFound') return 'deleted';
      // Disabling has not propagated yet; the sweep retries.
      if (name === 'ResourceNotDisabled' || name === 'PreconditionFailed')
        return 'disabling';
      throw err;
    }
  }

  /** The tenant CloudFront already holds for a domain, with its ETag; null when none. */
  private async findByDomain(
    hostname: string,
  ): Promise<{ tenant: DistributionTenant; etag: string | undefined } | null> {
    try {
      const res = await this.cf.send(
        new GetDistributionTenantByDomainCommand({ Domain: hostname }),
      );
      return res.DistributionTenant
        ? { tenant: res.DistributionTenant, etag: res.ETag }
        : null;
    } catch (err) {
      if ((err as { name?: string }).name === 'EntityNotFound') return null;
      throw err;
    }
  }

  async invalidateTenant(tenantId: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.cf.send(
      new CreateInvalidationForDistributionTenantCommand({
        Id: tenantId,
        InvalidationBatch: {
          CallerReference: `crux-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          Paths: { Quantity: paths.length, Items: paths },
        },
      }),
    );
  }

  /**
   * Tenants on the multi-tenant distribution that this API created (named
   * `<bucketPrefix><cruxId>-<hostname>`), one entry per domain. Anything else
   * on the distribution is left alone.
   */
  async listTenants(): Promise<EdgeTenant[]> {
    const prefix = this.cfg.bucketPrefix ?? 'crux-';
    const out: EdgeTenant[] = [];
    let marker: string | undefined;
    do {
      const res = await this.cf.send(
        new ListDistributionTenantsCommand({
          AssociationFilter: {
            DistributionId:
              this.cfg.tenantDistributionId ?? this.cfg.distributionId,
          },
          Marker: marker,
          MaxItems: 100,
        }),
      );
      for (const t of res.DistributionTenantList ?? []) {
        if (!t.Id || !t.Name?.startsWith(prefix)) continue;
        for (const d of t.Domains ?? []) {
          if (!d.Domain) continue;
          out.push({
            tenantId: t.Id,
            hostname: d.Domain.toLowerCase(),
            enabled: t.Enabled !== false,
          });
        }
      }
      marker = res.NextMarker;
    } while (marker);
    return out;
  }
}

/**
 * A tenant is live only when its DOMAIN is: "Deployed" says the tenant
 * configuration propagated, while the domain stays `inactive` until CloudFront
 * has established domain control (the certificate is issued and DNS points at
 * it). Reporting on the tenant alone showed a green light over a domain that
 * did not answer TLS yet.
 */
export function tenantState(
  tenant:
    | {
        Status?: string;
        Domains?: { Domain?: string; Status?: string }[];
      }
    | undefined,
): TenantStatus {
  const status = (tenant?.Status ?? '').toLowerCase();
  if (status.includes('fail')) return 'failed';
  const domains = tenant?.Domains ?? [];
  if (
    domains.length &&
    domains.every((d) => (d.Status ?? '').toLowerCase() === 'active')
  )
    return 'active';
  return 'issuing';
}

/** From env: the CloudFront provider when configured, else the mock. */
export function edgeProviderFromEnv(): EdgeProvider {
  const distributionId = process.env.PUBLISH_DISTRIBUTION_ID;
  const creds =
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : null;
  if (!distributionId || !creds) return new MockEdgeProvider();
  const region = process.env.AWS_REGION || 'us-east-1';
  return new CloudFrontEdgeProvider(
    new CloudFrontClient({ region: 'us-east-1', credentials: creds }),
    {
      region,
      distributionId,
      tenantDistributionId:
        process.env.PUBLISH_TENANT_DISTRIBUTION_ID || undefined,
      connectionGroupId: process.env.PUBLISH_CONNECTION_GROUP_ID,
      bucketPrefix: process.env.PUBLISH_BUCKET_PREFIX || 'crux-',
    },
  );
}
