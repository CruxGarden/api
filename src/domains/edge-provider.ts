import {
  CloudFrontClient,
  CreateDistributionTenantCommand,
  GetDistributionTenantCommand,
  DeleteDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';

/**
 * What the edge needs to serve a custom domain: a tenant on the publish
 * distribution (its certificate) and a hostname → cruxId mapping the
 * origin-request function reads. Behind an interface so the CloudFront
 * SaaS Manager flow can be swapped for ACM + alternate domains (ADR 0011)
 * without touching the domain lifecycle.
 */
export type TenantStatus = 'issuing' | 'active' | 'failed';

export interface EdgeProvider {
  createTenant(
    hostname: string,
    cruxId: string,
  ): Promise<{ tenantId: string; status: TenantStatus }>;
  tenantStatus(tenantId: string): Promise<TenantStatus>;
  deleteTenant(tenantId: string): Promise<void>;
  putMapping(hostname: string, cruxId: string): Promise<void>;
  deleteMapping(hostname: string): Promise<void>;
}

export class MockEdgeProvider implements EdgeProvider {
  tenants = new Map<
    string,
    { hostname: string; cruxId: string; checks: number }
  >();
  mappings = new Map<string, string>();
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
  async putMapping(hostname: string, cruxId: string) {
    this.mappings.set(hostname, cruxId);
  }
  async deleteMapping(hostname: string) {
    this.mappings.delete(hostname);
  }
}

export interface CloudFrontEdgeConfig {
  region: string;
  distributionId: string;
  connectionGroupId?: string;
  domainTable: string;
}

/** CloudFront SaaS Manager tenant + DynamoDB mapping. Needs live validation (see ADR 0011). */
export class CloudFrontEdgeProvider implements EdgeProvider {
  constructor(
    private readonly cf: CloudFrontClient,
    private readonly ddb: DynamoDBClient,
    private readonly cfg: CloudFrontEdgeConfig,
  ) {}

  async createTenant(hostname: string, cruxId: string) {
    const res = await this.cf.send(
      new CreateDistributionTenantCommand({
        DistributionId: this.cfg.distributionId,
        Name: `crux-${cruxId}-${hostname.replace(/[^a-z0-9]/g, '-')}`.slice(
          0,
          128,
        ),
        Domains: [{ Domain: hostname }],
        ConnectionGroupId: this.cfg.connectionGroupId,
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

  async putMapping(hostname: string, cruxId: string): Promise<void> {
    await this.ddb.send(
      new PutItemCommand({
        TableName: this.cfg.domainTable,
        Item: { hostname: { S: hostname }, cruxId: { S: cruxId } },
      }),
    );
  }

  async deleteMapping(hostname: string): Promise<void> {
    await this.ddb.send(
      new DeleteItemCommand({
        TableName: this.cfg.domainTable,
        Key: { hostname: { S: hostname } },
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
  const domainTable = process.env.PUBLISH_DOMAIN_TABLE;
  const creds =
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : null;
  if (!distributionId || !domainTable || !creds) return new MockEdgeProvider();
  const region = process.env.AWS_REGION || 'us-east-1';
  return new CloudFrontEdgeProvider(
    new CloudFrontClient({ region: 'us-east-1', credentials: creds }),
    new DynamoDBClient({ region, credentials: creds }),
    {
      region,
      distributionId,
      connectionGroupId: process.env.PUBLISH_CONNECTION_GROUP_ID,
      domainTable,
    },
  );
}
