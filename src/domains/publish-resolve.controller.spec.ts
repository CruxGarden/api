import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PublishResolveController } from './publish-resolve.controller';
import { DomainsService } from './domains.service';

describe('PublishResolveController', () => {
  const env = { ...process.env };
  const domains = {
    resolve: async (host: string) =>
      host === 'blog.example.com' ? 'crux-1' : null,
  } as unknown as DomainsService;
  const ctrl = new PublishResolveController(domains);

  beforeEach(() => {
    process.env.PUBLISH_ORIGIN_SECRET = 's3cret';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('refuses without the origin secret', async () => {
    await expect(ctrl.resolve('blog.example.com', undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(ctrl.resolve('blog.example.com', 'nope')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses everything when no secret is configured', async () => {
    delete process.env.PUBLISH_ORIGIN_SECRET;
    await expect(ctrl.resolve('blog.example.com', '')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('resolves a connected hostname and 404s an unknown one', async () => {
    expect(await ctrl.resolve('blog.example.com', 's3cret')).toEqual({
      cruxId: 'crux-1',
    });
    await expect(ctrl.resolve('other.example.com', 's3cret')).rejects.toThrow(
      NotFoundException,
    );
  });
});
