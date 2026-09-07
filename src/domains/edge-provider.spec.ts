import {
  CreateDistributionTenantCommand,
  CreateInvalidationForDistributionTenantCommand,
  DeleteDistributionTenantCommand,
  GetDistributionTenantCommand,
  GetDistributionTenantByDomainCommand,
  GetManagedCertificateDetailsCommand,
  UpdateDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import {
  CloudFrontEdgeProvider,
  TENANT_BUCKET_PARAMETER,
  edgeProviderFromEnv,
  MockEdgeProvider,
  tenantState,
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
        const answer = answers[Math.min(n++, answers.length - 1)] ?? {};
        if (typeof answer.__throw === 'string') {
          const err = new Error(answer.__throw);
          err.name = answer.__throw;
          throw err;
        }
        return answer;
      },
    } as never,
  };
}

describe('CloudFrontEdgeProvider', () => {
  it('creates the tenant on the multi-tenant distribution with the crux bucket as the origin parameter', async () => {
    const { client, sent } = fakeClient([
      { __throw: 'EntityNotFound' }, // no tenant for this domain yet

      {
        DistributionTenant: {
          Id: 'dt-1',
          Status: 'Deployed',
          Domains: [{ Domain: 'blog.example.com', Status: 'inactive' }],
        },
      },
    ]);
    const edge = new CloudFrontEdgeProvider(client, {
      region: 'us-east-1',
      distributionId: 'E-STANDARD',
      tenantDistributionId: 'E-TENANTS',
      connectionGroupId: 'cg-1',
    });
    const t = await edge.createTenant('blog.example.com', 'c1');
    expect(t).toEqual({ tenantId: 'dt-1', status: 'issuing' });
    expect(sent[0].name).toBe(GetDistributionTenantByDomainCommand.name);
    expect(sent[1].name).toBe(CreateDistributionTenantCommand.name);
    expect(sent[1].input).toMatchObject({
      DistributionId: 'E-TENANTS',
      ConnectionGroupId: 'cg-1',
      Domains: [{ Domain: 'blog.example.com' }],
      Parameters: [{ Name: TENANT_BUCKET_PARAMETER, Value: 'crux-c1' }],
      ManagedCertificateRequest: { ValidationTokenHost: 'cloudfront' },
      Enabled: true,
    });
    expect(TENANT_BUCKET_PARAMETER).toBe('bucket');
  });

  it('falls back to the standard distribution id when no tenant distribution is configured', async () => {
    const { client, sent } = fakeClient([
      { __throw: 'EntityNotFound' },

      {
        DistributionTenant: {
          Id: 'dt-2',
          Status: 'Deployed',
          Domains: [{ Domain: 'a.example.com', Status: 'active' }],
        },
      },
    ]);
    const edge = new CloudFrontEdgeProvider(client, {
      region: 'us-east-1',
      distributionId: 'E-ONLY',
    });
    expect(await edge.createTenant('a.example.com', 'c2')).toEqual({
      tenantId: 'dt-2',
      status: 'active',
    });
    expect(sent[1].input.DistributionId).toBe('E-ONLY');
  });

  it('invalidates through the tenant, and deletes with the ETag it just read', async () => {
    const { client, sent } = fakeClient([
      {},
      { ETag: 'etag-9', DistributionTenant: { Id: 'dt-1', Enabled: false } },
      {},
    ]);
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

  it('tenantState: only an active DOMAIN is active; Deployed with an inactive domain is still issuing', () => {
    expect(
      tenantState({ Status: 'Deployed', Domains: [{ Status: 'inactive' }] }),
    ).toBe('issuing');
    expect(
      tenantState({ Status: 'Deployed', Domains: [{ Status: 'active' }] }),
    ).toBe('active');
    expect(
      tenantState({ Status: 'InProgress', Domains: [{ Status: 'active' }] }),
    ).toBe('active');
    expect(
      tenantState({ Status: 'Failed', Domains: [{ Status: 'active' }] }),
    ).toBe('failed');
    expect(tenantState({ Status: 'Deployed', Domains: [] })).toBe('issuing');
    expect(tenantState(undefined)).toBe('issuing');
  });

  it('tenantStatus attaches an issued managed certificate to a tenant whose domain is still inactive', async () => {
    const tenant = {
      Id: 'dt-1',
      Status: 'Deployed',
      Enabled: true,
      ConnectionGroupId: 'cg-1',
      Domains: [{ Domain: 'blog.example.com', Status: 'inactive' }],
      Parameters: [{ Name: 'bucket', Value: 'crux-c1' }],
    };
    const { client, sent } = fakeClient([
      { DistributionTenant: tenant, ETag: 'etag-1' },
      {
        ManagedCertificateDetails: {
          CertificateArn: 'arn:acm:cert-1',
          CertificateStatus: 'issued',
        },
      },
      {
        DistributionTenant: {
          ...tenant,
          Domains: [{ Domain: 'blog.example.com', Status: 'active' }],
        },
      },
    ]);
    const edge = new CloudFrontEdgeProvider(client, {
      region: 'us-east-1',
      distributionId: 'E',
    });
    expect(await edge.tenantStatus('dt-1')).toBe('active');
    expect(sent.map((s) => s.name)).toEqual([
      GetDistributionTenantCommand.name,
      GetManagedCertificateDetailsCommand.name,
      UpdateDistributionTenantCommand.name,
    ]);
    expect(sent[2].input).toMatchObject({
      Id: 'dt-1',
      IfMatch: 'etag-1',
      Domains: [{ Domain: 'blog.example.com' }],
      Parameters: [{ Name: 'bucket', Value: 'crux-c1' }],
      Customizations: { Certificate: { Arn: 'arn:acm:cert-1' } },
      Enabled: true,
    });
  });

  it('tenantStatus leaves a tenant alone while its certificate is still pending or already attached', async () => {
    const pending = fakeClient([
      {
        DistributionTenant: {
          Id: 'dt-1',
          Status: 'Deployed',
          Domains: [{ Status: 'inactive' }],
        },
        ETag: 'e',
      },
      {
        ManagedCertificateDetails: {
          CertificateArn: 'arn:acm:cert-1',
          CertificateStatus: 'pending-validation',
        },
      },
    ]);
    const edge = new CloudFrontEdgeProvider(pending.client, {
      region: 'us-east-1',
      distributionId: 'E',
    });
    expect(await edge.tenantStatus('dt-1')).toBe('issuing');
    expect(pending.sent).toHaveLength(2);
    const attached = fakeClient([
      {
        DistributionTenant: {
          Id: 'dt-1',
          Status: 'Deployed',
          Domains: [{ Status: 'inactive' }],
          Customizations: { Certificate: { Arn: 'arn:acm:cert-1' } },
        },
        ETag: 'e',
      },
    ]);
    const edge2 = new CloudFrontEdgeProvider(attached.client, {
      region: 'us-east-1',
      distributionId: 'E',
    });
    expect(await edge2.tenantStatus('dt-1')).toBe('issuing');
    expect(attached.sent).toHaveLength(1);
  });

  it('deleteTenant disables an enabled tenant first and reports disabling when CloudFront is not ready', async () => {
    const live = {
      Id: 'dt-1',
      Enabled: true,
      ConnectionGroupId: 'cg-1',
      Domains: [{ Domain: 'blog.example.com', Status: 'active' }],
      Parameters: [{ Name: 'bucket', Value: 'crux-c1' }],
      Customizations: { Certificate: { Arn: 'arn:acm:1' } },
    };
    const { client, sent } = fakeClient([
      { ETag: 'e1', DistributionTenant: live },
      {
        ETag: 'e2',
        DistributionTenant: { ...live, Enabled: false, Status: 'InProgress' },
      },
      { __throw: 'ResourceNotDisabled' },
    ]);
    const edge = new CloudFrontEdgeProvider(client, {
      region: 'us-east-1',
      distributionId: 'E',
    });
    expect(await edge.deleteTenant('dt-1')).toBe('disabling');
    expect(sent.map((s) => s.name)).toEqual([
      GetDistributionTenantCommand.name,
      UpdateDistributionTenantCommand.name,
      DeleteDistributionTenantCommand.name,
    ]);
    expect(sent[1].input).toMatchObject({
      Id: 'dt-1',
      IfMatch: 'e1',
      Enabled: false,
      Customizations: { Certificate: { Arn: 'arn:acm:1' } },
    });
    expect(sent[2].input).toEqual({ Id: 'dt-1', IfMatch: 'e2' });
    const gone = fakeClient([{ __throw: 'EntityNotFound' }]);
    const edge2 = new CloudFrontEdgeProvider(gone.client, {
      region: 'us-east-1',
      distributionId: 'E',
    });
    expect(await edge2.deleteTenant('dt-x')).toBe('deleted');
  });

  it('createTenant reuses the tenant CloudFront already holds for the hostname', async () => {
    const parked = {
      Id: 'dt-old',
      Enabled: false,
      ConnectionGroupId: 'cg-1',
      Domains: [{ Domain: 'blog.example.com', Status: 'inactive' }],
      Parameters: [{ Name: 'bucket', Value: 'crux-old' }],
      Customizations: { Certificate: { Arn: 'arn:acm:1' } },
    };
    const { client, sent } = fakeClient([
      { ETag: 'e1', DistributionTenant: parked },
      {
        DistributionTenant: {
          ...parked,
          Enabled: true,
          Domains: [{ Domain: 'blog.example.com', Status: 'active' }],
        },
      },
    ]);
    const edge = new CloudFrontEdgeProvider(client, {
      region: 'us-east-1',
      distributionId: 'E',
      bucketPrefix: 'crux-',
    });
    expect(await edge.createTenant('blog.example.com', 'NEW')).toEqual({
      tenantId: 'dt-old',
      status: 'active',
    });
    expect(sent.map((s) => s.name)).toEqual([
      GetDistributionTenantByDomainCommand.name,
      UpdateDistributionTenantCommand.name,
    ]);
    expect(sent[1].input).toMatchObject({
      Id: 'dt-old',
      IfMatch: 'e1',
      Enabled: true,
      Parameters: [{ Name: 'bucket', Value: 'crux-new' }],
      Customizations: { Certificate: { Arn: 'arn:acm:1' } },
    });
    expect(sent[1].input).not.toHaveProperty('ManagedCertificateRequest');
  });
});
