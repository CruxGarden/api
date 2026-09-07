import { DomainsService } from './domains.service';
import { MockEdgeProvider } from './edge-provider';
import { CustomDomainRow } from './domains.repository';
import { normalizeHostname } from './dns-verifier';

const logger = {
  createChildLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
} as never;

function fakeRepo() {
  const rows = new Map<string, CustomDomainRow>();
  let n = 0;
  const ok = <T>(data: T) => Promise.resolve({ data, error: null });
  return {
    rows,
    create: jest.fn((r: Partial<CustomDomainRow>) => {
      const row = {
        id: `d${++n}`,
        status: 'pending_dns',
        tenant_id: null,
        error: null,
        created: new Date(),
        updated: new Date(),
        deleted: null,
        ...r,
      } as CustomDomainRow;
      rows.set(row.id, row);
      return ok(row);
    }),
    findById: jest.fn((id: string) => ok(rows.get(id))),
    findByHostname: jest.fn((h: string) =>
      ok([...rows.values()].find((r) => r.hostname === h && !r.deleted)),
    ),
    findLiveByHostname: jest.fn((h: string) =>
      ok(
        [...rows.values()].find(
          (r) =>
            r.hostname === h &&
            !r.deleted &&
            (r.status === 'issuing' || r.status === 'active'),
        ),
      ),
    ),
    expirePending: jest.fn(() => ok(0)),
    findDeletedWithTenant: jest.fn(() =>
      ok([...rows.values()].filter((r) => r.deleted && r.tenant_id)),
    ),
    findOpenHostnames: jest.fn(() =>
      ok([...rows.values()].filter((r) => !r.deleted).map((r) => r.hostname)),
    ),
    findLatestByHostnameForAuthor: jest.fn((h: string, a: string) =>
      ok(
        [...rows.values()]
          .filter((r) => r.hostname === h && r.author_id === a)
          .sort((x, y) => +new Date(y.updated) - +new Date(x.updated))[0],
      ),
    ),
    revive: jest.fn((id: string, cruxId: string) => {
      const row = {
        ...rows.get(id)!,
        crux_id: cruxId,
        status: 'pending_dns',
        error: null,
        deleted: null,
        updated: new Date(),
      } as CustomDomainRow;
      rows.set(id, row);
      return ok(row);
    }),
    countOpenByAuthor: jest.fn((a: string) =>
      ok(
        [...rows.values()].filter(
          (r) =>
            r.author_id === a &&
            !r.deleted &&
            ['pending_dns', 'issuing', 'active'].includes(r.status),
        ).length,
      ),
    ),
    findByCrux: jest.fn((c: string) =>
      ok([...rows.values()].filter((r) => r.crux_id === c)),
    ),
    findIssuing: jest.fn(() =>
      ok([...rows.values()].filter((r) => r.status === 'issuing')),
    ),
    update: jest.fn((id: string, patch: Partial<CustomDomainRow>) => {
      const row = { ...rows.get(id)!, ...patch } as CustomDomainRow;
      rows.set(id, row);
      return ok(row);
    }),
    remove: jest.fn((id: string) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, deleted: new Date() });
      return ok(undefined);
    }),
    authorForCrux: jest.fn(() => ok('a1')),
    publishState: jest.fn((cruxId: string) =>
      ok(
        cruxId === 'c-legacy'
          ? { published: true, layout: null }
          : cruxId === 'c-gone'
            ? { published: false, layout: null }
            : { published: true, layout: 'bucket-per-crux' },
      ),
    ),
  };
}

describe('DomainsService', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.PUBLISH_CNAME_TARGET = 'publish.crux.garden';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('normalises hostnames and refuses ours', () => {
    expect(normalizeHostname(' Blog.Example.com. ')).toBe('blog.example.com');
    expect(normalizeHostname('x.publish.crux.garden')).toBeNull();
    expect(normalizeHostname('not a host')).toBeNull();
    expect(normalizeHostname('-bad.example.com')).toBeNull();
  });

  it('walks pending_dns → issuing → active as records appear and the tenant deploys', async () => {
    const repo = fakeRepo();
    const svc = new DomainsService(repo as never, logger);
    const edge = new MockEdgeProvider();
    edge.activeAfterChecks = 2;
    const dns = { cname: [] as string[], txt: [] as string[] };
    svc.useProviders(edge, {
      cnameTargets: async () => dns.cname,
      txtValues: async () => dns.txt,
      addresses: async () => [],
    });

    const added = await svc.add('c1', 'a1', 'Blog.Example.com');
    expect(added.status).toBe('pending_dns');
    expect(added.records.map((r) => r.type)).toEqual(['CNAME', 'TXT']);
    expect(added.records[0]).toEqual({
      type: 'CNAME',
      name: 'blog.example.com',
      value: 'publish.crux.garden',
    });
    expect(added.records[1].name).toBe('_crux-verify.blog.example.com');
    const token = added.records[1].value;

    // nothing in DNS yet
    let v = await svc.verify(added.id);
    expect(v.status).toBe('pending_dns');
    expect(v.error).toMatch(/CNAME and TXT/);

    // only the CNAME
    dns.cname = ['PUBLISH.crux.garden.'];
    v = await svc.verify(added.id);
    expect(v.error).toMatch(/Waiting for the TXT record/);

    // both → tenant created, mapping written, issuing
    dns.txt = [token];
    v = await svc.verify(added.id);
    expect(v.status).toBe('issuing');
    expect(edge.tenants.size).toBe(1);
    // the edge can resolve it as soon as the tenant exists
    expect(await svc.resolve('Blog.Example.com')).toBe('c1');
    expect(await svc.resolve('nobody.example.com')).toBeNull();

    // verify already asked once (still issuing); the poller's next check sees it deployed
    expect(await svc.pollIssuing()).toBe(1);
    expect(await svc.pollIssuing()).toBe(0);
    expect((await svc.listForCrux('c1'))[0].status).toBe('active');

    // duplicates refused; removal cleans the edge
    await expect(svc.add('c2', 'a1', 'blog.example.com')).rejects.toThrow(
      /already connected/,
    );
    await svc.removeAllForCrux('c1');
    expect(edge.tenants.size).toBe(0);
    expect(await svc.resolve('blog.example.com')).toBeNull();
    // soft-deleted, like every other table
    expect([...repo.rows.values()].every((r) => r.deleted)).toBe(true);
  });

  it('a pending claim by someone else does not block the hostname; a live one does', async () => {
    const repo = fakeRepo();
    const svc = new DomainsService(repo as never, logger);
    const edge = new MockEdgeProvider();
    svc.useProviders(edge, {
      cnameTargets: async () => [],
      txtValues: async () => [],
      addresses: async () => [],
    });
    await svc.add('c-squatter', 'a-squatter', 'blog.example.com');
    const mine = await svc.add('c1', 'a1', 'blog.example.com');
    expect(mine.status).toBe('pending_dns');
    // once mine is live, a third claim is refused
    await repo.update(mine.id, { status: 'active' });
    await expect(svc.add('c2', 'a2', 'blog.example.com')).rejects.toThrow(
      /already connected/,
    );
    // pollIssuing sweeps stale claims
    await svc.pollIssuing();
    expect(repo.expirePending).toHaveBeenCalledWith(7);
  });

  it('resolveHost answers subdomains and custom domains with the publish layout', async () => {
    const repo = fakeRepo();
    const svc = new DomainsService(repo as never, logger);
    const edge = new MockEdgeProvider();
    svc.useProviders(edge, {
      cnameTargets: async () => ['publish.crux.garden'],
      txtValues: async () => [],
      addresses: async () => [],
    });
    const NEW = '550e8400-e29b-41d4-a716-446655440000';
    expect(await svc.resolveHost(`${NEW}.publish.crux.garden`)).toEqual({
      cruxId: NEW,
      legacy: false,
    });
    repo.publishState.mockImplementationOnce(async () => ({
      data: { published: true, layout: null },
      error: null,
    }));
    expect(await svc.resolveHost(`${NEW}.publish.crux.garden`)).toEqual({
      cruxId: NEW,
      legacy: true,
    });
    repo.publishState.mockImplementationOnce(async () => ({
      data: { published: false, layout: 'bucket-per-crux' },
      error: null,
    }));
    expect(await svc.resolveHost(`${NEW}.publish.crux.garden`)).toBeNull();
    // custom domain: only a live connection to a published crux answers
    const added = await svc.add('c-legacy', 'a1', 'blog.example.com');
    await repo.update(added.id, { status: 'active' });
    expect(await svc.resolveHost('Blog.Example.com')).toEqual({
      cruxId: 'c-legacy',
      legacy: true,
    });
    expect(await svc.resolveHost('nobody.example.com')).toBeNull();
  });

  it('records a failed certificate request and lets the user retry', async () => {
    const repo = fakeRepo();
    const svc = new DomainsService(repo as never, logger);
    const edge = new MockEdgeProvider();
    edge.createTenant = async () => {
      throw new Error('SaaS Manager unavailable');
    };
    svc.useProviders(edge, {
      cnameTargets: async () => ['publish.crux.garden'],
      txtValues: async () => [],
      addresses: async () => [],
    });
    const added = await svc.add('c1', 'a1', 'a.example.com');
    const token = added.records[1].value;
    svc.useProviders(edge, {
      cnameTargets: async () => ['publish.crux.garden'],
      txtValues: async () => [token],
      addresses: async () => [],
    });
    const v = await svc.verify(added.id);
    expect(v.status).toBe('failed');
    expect(v.error).toMatch(/SaaS Manager unavailable/);
    edge.createTenant = MockEdgeProvider.prototype.createTenant.bind(edge);
    // tenant created and (mock) deployed on its first status check → active
    expect((await svc.verify(added.id)).status).toBe('active');
  });

  it('refuses a tenant for a crux that is unpublished or still in the shared bucket', async () => {
    const repo = fakeRepo();
    const svc = new DomainsService(repo as never, logger);
    const edge = new MockEdgeProvider();
    edge.activeAfterChecks = 2; // verify()'s own first status check must not already say active
    svc.useProviders(edge, {
      cnameTargets: async () => ['publish.crux.garden'],
      txtValues: async () => [
        `crux-verify=${[...repo.rows.values()][0]?.token ?? ''}`,
      ],
      addresses: async () => [],
    });
    const added = await svc.add('c1', 'a1', 'shop.example.com');
    // records present, but the crux was published before bucket-per-crux
    repo.publishState.mockImplementation(() =>
      Promise.resolve({
        data: { published: true, layout: 'shared' },
        error: null,
      }),
    );
    let v = await svc.verify(added.id);
    expect(v.status).toBe('failed');
    expect(v.error).toMatch(/Republish the crux first/);
    expect(edge.tenants.size).toBe(0);
    // not published at all
    repo.publishState.mockImplementation(() =>
      Promise.resolve({
        data: { published: false, layout: null },
        error: null,
      }),
    );
    v = await svc.verify(added.id);
    expect(v.error).toMatch(/Publish the crux first/);
    // republished into its own bucket → the tenant is created
    repo.publishState.mockImplementation(() =>
      Promise.resolve({
        data: { published: true, layout: 'bucket-per-crux' },
        error: null,
      }),
    );
    v = await svc.verify(added.id);
    expect(v.status).toBe('issuing');
    expect([...edge.tenants.values()][0]).toMatchObject({ cruxId: 'c1' });
  });

  it('a republish invalidates every active tenant of the crux, and only those', async () => {
    const repo = fakeRepo();
    const svc = new DomainsService(repo as never, logger, {
      planIdFor: async () => 'gardener',
    } as never);
    const edge = new MockEdgeProvider();
    svc.useProviders(edge, {
      cnameTargets: async () => ['publish.crux.garden'],
      txtValues: async () =>
        [...repo.rows.values()].map((r) => `crux-verify=${r.token}`),
      addresses: async () => [],
    });
    const a = await svc.add('c1', 'a1', 'a.example.com');
    const b = await svc.add('c1', 'a1', 'b.example.com');
    await svc.verify(a.id); // issuing
    await svc.verify(b.id); // issuing
    await svc.pollIssuing(); // both active
    await svc.invalidateForCrux('c1');
    expect(edge.invalidations).toHaveLength(2);
    expect(edge.invalidations[0]).toEqual({
      tenantId: 'tenant-1',
      paths: ['/*'],
    });
    await svc.invalidateForCrux('c-other');
    expect(edge.invalidations).toHaveLength(2);
  });

  it('a bare domain: ALIAS + www CNAME + TXT without a gatepost; the tenant serves www; both names resolve', async () => {
    delete process.env.APEX_REDIRECT_IPS;
    const repo = fakeRepo();
    const svc = new DomainsService(repo as never, logger, {
      planIdFor: async () => 'gardener',
    } as never);
    const edge = new MockEdgeProvider();
    edge.activeAfterChecks = 2;
    const dns = {
      apexA: [] as string[],
      wwwCname: [] as string[],
      txt: [] as string[],
    };
    svc.useProviders(edge, {
      cnameTargets: async (h) => (h === 'www.zacos.tech' ? dns.wwwCname : []),
      txtValues: async () => dns.txt,
      addresses: async (h) =>
        h === 'publish.crux.garden'
          ? ['13.249.52.67', '13.249.52.75']
          : h === 'zacos.tech'
            ? dns.apexA
            : [],
    });
    const added = await svc.add('c1', 'a1', 'zacos.tech');
    expect(added.records.map((r) => [r.type, r.name, r.value])).toEqual([
      ['ALIAS', 'zacos.tech', 'publish.crux.garden'],
      ['CNAME', 'www.zacos.tech', 'publish.crux.garden'],
      ['TXT', '_crux-verify.zacos.tech', added.records[2].value],
    ]);
    let v = await svc.verify(added.id);
    expect(v.error).toBe(
      'Waiting for the ALIAS and CNAME for www and TXT record',
    );
    dns.txt = [added.records[2].value];
    dns.wwwCname = ['publish.crux.garden'];
    v = await svc.verify(added.id);
    expect(v.error).toBe('Waiting for the ALIAS record');
    dns.apexA = ['13.249.52.75'];
    v = await svc.verify(added.id);
    expect(v.status).toBe('issuing');
    // the tenant is for www — that is where the files are served from
    expect([...edge.tenants.values()][0]).toMatchObject({
      hostname: 'www.zacos.tech',
      cruxId: 'c1',
    });
    expect(await svc.resolve('www.zacos.tech')).toBe('c1');
    expect(await svc.resolve('zacos.tech')).toBe('c1');
    expect(await svc.isGatepostHost('zacos.tech')).toBe(true);
    expect(await svc.isGatepostHost('www.zacos.tech')).toBe(false);
    expect(await svc.isGatepostHost('nobody.tech')).toBe(false);
    // a subdomain is still a plain CNAME
    const sub = await svc.add('c1', 'a1', 'blog.zacos.tech');
    expect(sub.records.map((r) => r.type)).toEqual(['CNAME', 'TXT']);
  });

  it('with a gatepost configured, a bare domain gets A/AAAA records and verifies when they match', async () => {
    process.env.APEX_REDIRECT_IPS = '203.0.113.10, 203.0.113.11,2001:db8::10';
    try {
      const repo = fakeRepo();
      const svc = new DomainsService(repo as never, logger);
      const edge = new MockEdgeProvider();
      edge.activeAfterChecks = 2;
      const dns = { apex: [] as string[] };
      svc.useProviders(edge, {
        cnameTargets: async (h) =>
          h === 'www.zacos.tech' ? ['publish.crux.garden'] : [],
        txtValues: async () =>
          [...repo.rows.values()].map((r) => `crux-verify=${r.token}`),
        addresses: async (h) => (h === 'zacos.tech' ? dns.apex : []),
      });
      const added = await svc.add('c1', 'a1', 'zacos.tech');
      expect(added.records.map((r) => [r.type, r.value])).toEqual([
        ['A', '203.0.113.10'],
        ['A', '203.0.113.11'],
        ['AAAA', '2001:db8::10'],
        ['CNAME', 'publish.crux.garden'],
        ['TXT', added.records[4].value],
      ]);
      dns.apex = ['203.0.113.10', '1.2.3.4']; // one stray address → not ours
      let v = await svc.verify(added.id);
      expect(v.error).toBe('Waiting for the A record');
      dns.apex = ['203.0.113.10', '203.0.113.11'];
      v = await svc.verify(added.id);
      expect(v.status).toBe('issuing');
    } finally {
      delete process.env.APEX_REDIRECT_IPS;
    }
  });

  it('custom domains are a Gardener feature: Free connects none, Gardener ten, a removed one frees its slot', async () => {
    const repo = fakeRepo();
    let planId = 'free';
    const billing = { planIdFor: async () => planId } as never;
    const svc = new DomainsService(repo as never, logger, billing);
    await expect(
      svc.add('c1', 'a1', 'one.example.com', 'acct-1'),
    ).rejects.toMatchObject({
      status: 402,
      response: expect.objectContaining({ kind: 'domains', limit: 0, used: 0 }),
    });
    await expect(
      svc.add('c1', 'a1', 'one.example.com', 'acct-1'),
    ).rejects.toThrow(/come with Gardener/);
    // upgrading lifts it
    planId = 'gardener';
    await svc.add('c1', 'a1', 'one.example.com', 'acct-1');
    await svc.add('c1', 'a1', 'two.example.com', 'acct-1');
    // a removed (soft-deleted) domain frees its slot
    const [first] = await svc.listForCrux('c1');
    await svc.remove(first.id);
    expect((await repo.countOpenByAuthor('a1')).data).toBe(1);
    // without billing wired (self-hosted) there is nothing to buy and no gate
    const open = new DomainsService(fakeRepo() as never, logger);
    await open.add('c9', 'a9', 'free.example.com');
  });

  it('active means the site answers: a tenant CloudFront calls active stays issuing until https://host/ responds', async () => {
    const repo = fakeRepo();
    const svc = new DomainsService(repo as never, logger);
    const edge = new MockEdgeProvider(); // active on the first status check
    let up = false;
    const probed: string[] = [];
    svc.useProviders(
      edge,
      {
        cnameTargets: async () => ['publish.crux.garden'],
        txtValues: async () =>
          [...repo.rows.values()].map((r) => `crux-verify=${r.token}`),
        addresses: async () => [],
      },
      async (host) => {
        probed.push(host);
        return up;
      },
    );
    const added = await svc.add('c1', 'a1', 'blog.example.com');
    let v = await svc.verify(added.id); // records ok → tenant created → CloudFront active → probe fails
    expect(v.status).toBe('issuing');
    expect(v.error).toMatch(
      /waiting for https:\/\/blog\.example\.com\/ to answer/,
    );
    expect(probed).toEqual(['blog.example.com']);
    up = true;
    v = await svc.verify(added.id);
    expect(v.status).toBe('active');
    expect(v.error).toBeNull();
  });

  it('disconnect then reconnect just works: the row revives with its token and the tenant is reused', async () => {
    const repo = fakeRepo();
    const svc = new DomainsService(repo as never, logger);
    const edge = new MockEdgeProvider();
    edge.deleteNeedsTwoSteps = true; // CloudFront: disable first, delete later
    svc.useProviders(edge, {
      cnameTargets: async () => ['publish.crux.garden'],
      txtValues: async () =>
        [...repo.rows.values()].map((r) => `crux-verify=${r.token}`),
      addresses: async () => [],
    });
    const first = await svc.add('c1', 'a1', 'blog.example.com');
    expect((await svc.verify(first.id)).status).toBe('active');
    const tenantId = [...edge.tenants.keys()][0]!;

    // Disconnect: the tenant goes dark at once; CloudFront would not delete it yet
    await svc.remove(first.id);
    expect(edge.tenants.get(tenantId)?.enabled).toBe(false);
    expect(repo.rows.get(first.id)!.deleted).toBeTruthy();
    expect(repo.rows.get(first.id)!.tenant_id).toBe(tenantId); // kept for the sweep
    expect(await svc.resolve('blog.example.com')).toBeNull();

    // Reconnect the same hostname (to another crux, even): the old row comes back,
    // same token — the TXT they already have still verifies — and the tenant is reused
    const again = await svc.add('c2', 'a1', 'blog.example.com');
    expect(again.id).toBe(first.id);
    expect(again.records.find((r) => r.type === 'TXT')!.value).toBe(
      first.records.find((r) => r.type === 'TXT')!.value,
    );
    expect(again.status).toBe('pending_dns');
    expect((await svc.verify(again.id)).status).toBe('active');
    expect(edge.tenants.size).toBe(1);
    expect(edge.tenants.get(tenantId)).toMatchObject({
      cruxId: 'c2',
      enabled: true,
    });
    expect(await svc.resolve('blog.example.com')).toBe('c2');
  });

  it('the sweep finishes deletes CloudFront deferred, and leaves a revived domain alone', async () => {
    const repo = fakeRepo();
    const svc = new DomainsService(repo as never, logger);
    const edge = new MockEdgeProvider();
    edge.deleteNeedsTwoSteps = true;
    svc.useProviders(edge, {
      cnameTargets: async () => ['publish.crux.garden'],
      txtValues: async () =>
        [...repo.rows.values()].map((r) => `crux-verify=${r.token}`),
      addresses: async () => [],
    });
    const a = await svc.add('c1', 'a1', 'a.example.com');
    await svc.verify(a.id);
    await svc.removeAllForCrux('c1'); // unpublish
    expect(edge.tenants.size).toBe(1); // disabled, not yet deleted
    expect(await svc.sweepTenants()).toBe(1); // second attempt deletes
    expect(edge.tenants.size).toBe(0);
    expect(repo.rows.get(a.id)!.tenant_id).toBeNull();
    // re-adding afterwards revives the row and creates a fresh tenant
    const back = await svc.add('c1', 'a1', 'a.example.com');
    expect(back.id).toBe(a.id);
    expect((await svc.verify(back.id)).status).toBe('active');
    expect(edge.tenants.size).toBe(1);
  });

  it('the sweep removes a tenant no live row claims, and keeps the claimed ones', async () => {
    const repo = fakeRepo();
    const svc = new DomainsService(repo as never, logger);
    const edge = new MockEdgeProvider();
    svc.useProviders(edge, {
      cnameTargets: async () => ['publish.crux.garden'],
      txtValues: async () =>
        [...repo.rows.values()].map((r) => `crux-verify=${r.token}`),
      addresses: async () => [],
    });
    const kept = await svc.add('c1', 'a1', 'kept.example.com');
    await svc.verify(kept.id);
    const lost = await svc.add('c2', 'a2', 'lost.example.com');
    await svc.verify(lost.id);
    // the row vanished without the tenant going with it (the old cascade on unpublish)
    repo.rows.delete(lost.id);
    expect(edge.tenants.size).toBe(2);
    expect(await svc.sweepTenants()).toBe(1);
    expect([...edge.tenants.values()].map((t) => t.hostname)).toEqual([
      'kept.example.com',
    ]);
    // a pending row (tenant not yet created) is still a claim: nothing to sweep
    await svc.add('c3', 'a3', 'soon.example.com');
    expect(await svc.sweepTenants()).toBe(0);
  });
});
