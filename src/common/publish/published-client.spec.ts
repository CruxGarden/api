import { runInNewContext } from 'node:vm';
import { PUBLISH_INJECTIONS } from './publish-injections';

const cruxId = '11111111-1111-4111-8111-111111111111';
const apiBase = 'https://api.crux.garden';
const garden = 'https://crux.garden';
function page(framed = false) {
  const handlers = new Set<(e: any) => void>();
  const parent = { postMessage: jest.fn() };
  const window: any = {
    dispatchEvent: jest.fn(),
    parent,
    addEventListener: (_: string, fn: any) => handlers.add(fn),
    removeEventListener: (_: string, fn: any) => handlers.delete(fn),
  };
  if (!framed) window.parent = window;
  const fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ value: 'saved' }),
  });
  const injection = PUBLISH_INJECTIONS.find(
    (i) => i.id === 'crux-store-client',
  )!;
  const script =
    typeof injection.script === 'function'
      ? injection.script({
          cruxId,
          apiBase,
          artifact: {} as any,
          allArtifacts: [],
        })
      : injection.script;
  runInNewContext(script, {
    window,
    CustomEvent: class {
      constructor(public type: string) {}
    },
    fetch,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  return {
    sdk: window.crux,
    parent,
    fetch,
    deliver(data: unknown, origin = garden, source: unknown = parent) {
      for (const handler of [...handlers]) handler({ data, origin, source });
    },
  };
}
const response = (data: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
});

describe('Published embedded library', () => {
  it('uses scoped login, refreshes an expired credential, then revokes it on logout', async () => {
    const p = page();
    p.fetch.mockResolvedValueOnce(response({ message: 'sent' }));
    await p.sdk.auth.requestCode('reader@example.com');
    expect(p.fetch.mock.calls[0][0]).toBe(
      `${apiBase}/published-auth/${cruxId}/code`,
    );
    p.fetch.mockResolvedValueOnce(
      response({
        accessToken: 'pv_first',
        refreshToken: 'pr_first',
        visitor: { id: 'reader' },
      }),
    );
    expect(await p.sdk.auth.login('reader@example.com', 'pc_code')).toEqual({
      id: 'reader',
    });
    p.fetch
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(
        response({
          accessToken: 'pv_second',
          refreshToken: 'pr_second',
          visitor: { id: 'reader' },
        }),
      )
      .mockResolvedValueOnce(response({ value: 8 }));
    expect(await p.sdk.store.increment('score')).toBe(8);
    expect(p.fetch.mock.calls.slice(-1)[0][1].headers.Authorization).toBe(
      'Bearer pv_second',
    );
    p.fetch.mockResolvedValueOnce(response(null, 204));
    await p.sdk.auth.logout();
    expect(await p.sdk.auth.profile()).toBeNull();
    await p.sdk.store.get('score');
    expect(
      p.fetch.mock.calls.slice(-1)[0][1].headers.Authorization,
    ).toBeUndefined();
    expect(p.parent.postMessage).not.toHaveBeenCalled();
  });

  it.each([garden, 'crux-app://index.html'])(
    'accepts only the Garden parent %s and refuses forged replies; writes await success or failure',
    async (hostOrigin) => {
      const p = page(true);
      const session = {
        type: 'crux:session',
        cruxId,
        mode: 'local',
        token: 'broad-token',
        apiBase: 'https://evil.example',
      };
      p.deliver(session, 'https://evil.example');
      p.deliver(session, garden, {});
      p.deliver({ ...session, cruxId: 'another' });
      p.deliver(session, hostOrigin);
      const saved = p.sdk.store.set('note', 'private');
      await Promise.resolve();
      const [message, destination] =
        p.parent.postMessage.mock.calls.slice(-1)[0];
      expect(destination).toBe(hostOrigin);
      let settled = false;
      saved.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      p.deliver(
        { type: 'crux:store:set:res', id: message.id, value: true },
        'https://evil.example',
      );
      p.deliver(
        { type: 'crux:store:set:res', id: message.id, value: true },
        garden,
        {},
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      p.deliver(
        {
          type: 'crux:store:set:res',
          id: message.id,
          error: 'Write refused',
        },
        hostOrigin,
      );
      await expect(saved).rejects.toThrow('Write refused');
      expect(p.fetch).not.toHaveBeenCalled();
      await expect(
        p.sdk.auth.login('reader@example.com', 'code'),
      ).rejects.toThrow('Crux Garden');
    },
  );

  it('does not let an arbitrary embedder redirect standalone requests or supply a token', async () => {
    const p = page();
    p.deliver(
      {
        type: 'crux:session',
        cruxId: 'another',
        token: 'stolen',
        mode: 'live',
        apiBase: 'https://evil.example',
      },
      'https://evil.example',
    );
    await p.sdk.store.get('hello');
    expect(p.fetch.mock.calls[0][0]).toBe(`${apiBase}/store/${cruxId}/hello`);
    expect(p.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
