import {
  CreateDistributionTenantCommand,
  CreateInvalidationForDistributionTenantCommand,
  DeleteDistributionTenantCommand,
  GetDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import {
  CloudFrontEdgeProvider,
  TENANT_CRUX_PARAMETER,
  edgeProviderFromEnv,
  MockEdgeProvider,
} from './edge-provider';

/** A CloudFront client that records commands and answers from a script. */
function fakeClient(answers: Record<string, unknown>[] = []) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  let n = 0;
  return {
    sent,
    client: {
      send: async (cmd: {
        constructor: { name: string };
        input: Record<string, unknown>;
      }) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        return answers[Math.min(n++, answers.length - 1)] ?? {};
      },
    } as never,
  };
}

describe('CloudFrontEdgeProvider', () => {
  it('creates the tenant on the multi-tenant distribution with the crux id as the origin parameter', async () => {
    const { client, sent } = fakeClient([
      { DistributionTenant: { Id: 'dt-1', Status: 'InProgress' } },
    ]);
    const edge = new CloudFrontEdgeProvider(client, {
      region: 'us-east-1',
      distributionId: 'E-STANDARD',
      tenantDistributionId: 'E-TENANTS',
      connectionGroupId: 'cg-1',
    });
    const t = await edge.createTenant('blog.example.com', 'c1');
    expect(t).toEqual({ tenantId: 'dt-1', status: 'issuing' });
    expect(sent[0].name).toBe(CreateDistributionTenantCommand.name);
    expect(sent[0].input).toMatchObject({
      DistributionId: 'E-TENANTS',
      ConnectionGroupId: 'cg-1',
      Domains: [{ Domain: 'blog.example.com' }],
      Parameters: [{ Name: TENANT_CRUX_PARAMETER, Value: 'c1' }],
      ManagedCertificateRequest: { ValidationTokenHost: 'cloudfront' },
      Enabled: true,
    });
    expect(TENANT_CRUX_PARAMETER).toBe('cruxId');
  });

  it('falls back to the standard distribution id when no tenant distribution is configured', async () => {
    const { client, sent } = fakeClient([
      { DistributionTenant: { Id: 'dt-2', Status: 'Deployed' } },
    ]);
    const edge = new CloudFrontEdgeProvider(client, {
      region: 'us-east-1',
      distributionId: 'E-ONLY',
    });
    expect(await edge.createTenant('a.example.com', 'c2')).toEqual({
      tenantId: 'dt-2',
      status: 'active',
    });
    expect(sent[0].input.DistributionId).toBe('E-ONLY');
  });

  it('invalidates through the tenant, and deletes with the ETag it just read', async () => {
    const { client, sent } = fakeClient([{}, { ETag: 'etag-9' }, {}]);
    const edge = new CloudFrontEdgeProvider(client, {
      region: 'us-east-1',
      distributionId: 'E',
    });
    await edge.invalidateTenant('dt-1', ['/*']);
    expect(sent[0].name).toBe(
      CreateInvalidationForDistributionTenantCommand.name,
    );
    expect(sent[0].input).toMatchObject({
      Id: 'dt-1',
      InvalidationBatch: { Paths: { Quantity: 1, Items: ['/*'] } },
    });
    await edge.invalidateTenant('dt-1', []); // nothing to do, nothing sent
    expect(sent).toHaveLength(1);
    await edge.deleteTenant('dt-1');
    expect(sent[1].name).toBe(GetDistributionTenantCommand.name);
    expect(sent[2].name).toBe(DeleteDistributionTenantCommand.name);
    expect(sent[2].input).toEqual({ Id: 'dt-1', IfMatch: 'etag-9' });
  });

  it('edgeProviderFromEnv is the mock without a distribution id and credentials', () => {
    const saved = { ...process.env };
    delete process.env.PUBLISH_DISTRIBUTION_ID;
    expect(edgeProviderFromEnv()).toBeInstanceOf(MockEdgeProvider);
    process.env = saved;
  });
});
