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
    });
    const added = await svc.add('c1', 'a1', 'a.example.com');
    const token = added.records[1].value;
    svc.useProviders(edge, {
      cnameTargets: async () => ['publish.crux.garden'],
      txtValues: async () => [token],
    });
    const v = await svc.verify(added.id);
    expect(v.status).toBe('failed');
    expect(v.error).toMatch(/SaaS Manager unavailable/);
    edge.createTenant = MockEdgeProvider.prototype.createTenant.bind(edge);
    // tenant created and (mock) deployed on its first status check → active
    expect((await svc.verify(added.id)).status).toBe('active');
  });
});
