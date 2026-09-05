import {
  CloudFrontClient,
  CreateDistributionTenantCommand,
  CreateInvalidationForDistributionTenantCommand,
  GetDistributionTenantCommand,
  DeleteDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';

/**
 * What the edge needs to serve a custom domain: a distribution tenant on the
 * multi-tenant "domains" distribution (ADR 0011, amended 2026-09-05). The
 * tenant carries the hostname, a CloudFront-managed certificate, and one
 * parameter — the crux id — which the multi-tenant distribution substitutes
 * into its origin domain (`crux-{{cruxId}}.s3-website-….amazonaws.com`). No
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
  deleteTenant(tenantId: string): Promise<void>;
  /** Drop the tenant's cached objects after a republish (best effort). */
  invalidateTenant(tenantId: string, paths: string[]): Promise<void>;
}

export class MockEdgeProvider implements EdgeProvider {
  tenants = new Map<
    string,
    { hostname: string; cruxId: string; checks: number }
  >();
  /** how many status checks before a tenant reports active */
  activeAfterChecks = 1;
  private n = 0;
  async createTenant(hostname: string, cruxId: string) {
    const tenantId = `tenant-${++this.n}`;
    this.tenants.set(tenantId, { hostname, cruxId, checks: 0 });
    return { tenantId, status: 'issuing' as const };
  }
  async tenantStatus(tenantId: string): Promise<TenantStatus> {
    const t = this.tenants.get(tenantId);
    if (!t) return 'failed';
    t.checks += 1;
    return t.checks >= this.activeAfterChecks ? 'active' : 'issuing';
  }
  async deleteTenant(tenantId: string) {
    this.tenants.delete(tenantId);
  }
  invalidations: { tenantId: string; paths: string[] }[] = [];
  async invalidateTenant(tenantId: string, paths: string[]) {
    this.invalidations.push({ tenantId, paths });
  }
}

export interface CloudFrontEdgeConfig {
  region: string;
  /** The standard distribution (wildcard `*.publish.crux.garden`, origin router). */
  distributionId: string;
  /** The multi-tenant distribution tenants attach to; falls back to distributionId. */
  tenantDistributionId?: string;
  connectionGroupId?: string;
}

/** The parameter the multi-tenant distribution substitutes into its origin domain. */
export const TENANT_CRUX_PARAMETER = 'cruxId';

/** CloudFront SaaS Manager tenant. Needs live validation (see ADR 0011). */
export class CloudFrontEdgeProvider implements EdgeProvider {
  constructor(
    private readonly cf: CloudFrontClient,
    private readonly cfg: CloudFrontEdgeConfig,
  ) {}

  async createTenant(hostname: string, cruxId: string) {
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
        // → origin domain crux-<cruxId>.s3-website-<region>.amazonaws.com
        Parameters: [{ Name: TENANT_CRUX_PARAMETER, Value: cruxId }],
        // CloudFront-managed certificate: validation rides on the CNAME the user already created
        ManagedCertificateRequest: { ValidationTokenHost: 'cloudfront' },
        Tags: { Items: [{ Key: 'crux-garden:crux', Value: cruxId }] },
        Enabled: true,
      }),
    );
    const tenantId = res.DistributionTenant?.Id;
    if (!tenantId) throw new Error('CloudFront did not return a tenant id');
    return { tenantId, status: this.mapStatus(res.DistributionTenant?.Status) };
  }

  async tenantStatus(tenantId: string): Promise<TenantStatus> {
    const res = await this.cf.send(
      new GetDistributionTenantCommand({ Identifier: tenantId }),
    );
    return this.mapStatus(res.DistributionTenant?.Status);
  }

  async deleteTenant(tenantId: string): Promise<void> {
    const res = await this.cf.send(
      new GetDistributionTenantCommand({ Identifier: tenantId }),
    );
    await this.cf.send(
      new DeleteDistributionTenantCommand({ Id: tenantId, IfMatch: res.ETag }),
    );
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

  private mapStatus(status?: string): TenantStatus {
    if (!status) return 'issuing';
    const s = status.toLowerCase();
    if (s === 'deployed' || s === 'active') return 'active';
    if (s.includes('fail')) return 'failed';
    return 'issuing';
  }
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
    },
  );
}
