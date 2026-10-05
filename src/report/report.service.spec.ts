import { NotFoundException } from '@nestjs/common';
import { ReportService, NOT_PUBLISHED } from './report.service';
import Crux from '../crux/entities/crux.entity';

describe('ReportService', () => {
  const env = { ...process.env };
  const crux = new Crux({
    id: 'crux-1',
    slug: 'a-site',
    title: 'A site',
    authorId: 'author-1',
    meta: { publishedAt: '2026-10-01T00:00:00Z' },
  });
  const raw = (fields: Record<string, unknown> = {}) => ({
    id: 'report-1',
    crux_id: 'crux-1',
    crux_title: 'A site',
    reason: 'spam',
    status: 'open',
    created: new Date(),
    updated: new Date(),
    deleted: null,
    ...fields,
  });
  function fixture() {
    const repository = {
      create: jest.fn(async (report) => ({
        data: raw({
          reporter_email: report.reporterEmail,
          details: report.details,
          author_id: report.authorId,
        }),
        error: null,
      })),
      findById: jest.fn(async () => ({ data: raw(), error: null })),
      update: jest.fn(async (_id, resolution) => ({
        data: raw({ status: resolution.status }),
        error: null,
      })),
      resolveOpenForCrux: jest.fn(async () => ({ data: 1, error: null })),
      operatorEmails: jest.fn(async () => ({
        data: [] as string[],
        error: null as Error | null,
      })),
      summary: jest.fn(async (since: Date) => {
        void since;
        return {
          data: { open: 2, resolvedLast30d: 5, takenDown: 1 },
          error: null as Error | null,
        };
      }),
    };
    const cruxService = {
      findById: jest.fn(async () => crux),
      takeDownCrux: jest.fn(async () => ({ id: 'takedown-1' })),
      liftTakedown: jest.fn(),
    };
    const email = { send: jest.fn() };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const service = new ReportService(
      repository as never,
      cruxService as never,
      email as never,
      { generateId: () => 'report-1' } as never,
      { createChildLogger: () => logger } as never,
    );
    return { service, repository, cruxService, email, logger };
  }

  beforeEach(() => {
    process.env.JWT_SECRET = 'salt';
    delete process.env.USAGE_VISITOR_SALT;
    delete process.env.REPORTS_NOTIFY_EMAIL;
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
  });
  afterAll(() => {
    process.env = env;
  });

  it('answers an unknown crux and an unpublished one identically', async () => {
    const { service, cruxService, repository } = fixture();
    cruxService.findById.mockRejectedValueOnce(
      new NotFoundException('Crux not found'),
    );
    await expect(
      service.create({ cruxId: 'missing', reason: 'spam' }),
    ).rejects.toThrow(NOT_PUBLISHED);

    cruxService.findById.mockResolvedValueOnce(new Crux({ ...crux, meta: {} }));
    await expect(
      service.create({ cruxId: 'crux-1', reason: 'spam' }),
    ).rejects.toThrow(NOT_PUBLISHED);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('does not turn a failed lookup into a 404', async () => {
    const { service, cruxService } = fixture();
    cruxService.findById.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.create({ cruxId: 'crux-1', reason: 'spam' }),
    ).rejects.toThrow('db down');
  });

  it('stores a stable salted hash of the address, never the address', async () => {
    const { service, repository } = fixture();
    await service.create({ cruxId: 'crux-1', reason: 'spam' }, '203.0.113.9');
    await service.create({ cruxId: 'crux-1', reason: 'spam' }, '203.0.113.9');
    await service.create({ cruxId: 'crux-1', reason: 'spam' }, '203.0.113.10');
    await service.create({ cruxId: 'crux-1', reason: 'spam' });

    const hashes = repository.create.mock.calls.map(
      ([report]) => report.reporterIpHash,
    );
    expect(hashes[0]).toMatch(/^[\w-]{22}$/);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
    expect(hashes[3]).toBeUndefined();
    expect(JSON.stringify(repository.create.mock.calls)).not.toContain(
      '203.0.113',
    );
    expect(repository.create.mock.calls[0][0]).toMatchObject({
      id: 'report-1',
      cruxId: 'crux-1',
      authorId: 'author-1',
      cruxSlug: 'a-site',
      cruxTitle: 'A site',
    });
  });

  it('emails the operator only when a recipient exists', async () => {
    const { service, email, logger } = fixture();
    await service.create({ cruxId: 'crux-1', reason: 'spam' });
    expect(email.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('REPORTS_NOTIFY_EMAIL'),
      expect.anything(),
    );

    process.env.REPORTS_NOTIFY_EMAIL = 'abuse@example.com';
    await service.create({
      cruxId: 'crux-1',
      reason: 'spam',
      details: 'Link farm',
      email: 'Me@Example.com',
    });
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'abuse@example.com',
        subject: 'Report (spam): A site',
        body: expect.stringContaining('Link farm'),
      }),
    );
    expect(email.send.mock.calls[0][0].body).toContain('me@example.com');
  });

  it('keeps the report when the notification fails', async () => {
    const { service, email, logger } = fixture();
    process.env.REPORTS_NOTIFY_EMAIL = 'abuse@example.com';
    email.send.mockRejectedValue(new Error('SES down'));

    const report = await service.create({ cruxId: 'crux-1', reason: 'spam' });

    expect(report.id).toBe('report-1');
    expect(logger.error).toHaveBeenCalled();
  });

  it('surfaces a storage failure as a server error', async () => {
    const { service, repository } = fixture();
    repository.create.mockResolvedValueOnce({
      data: null,
      error: new Error('insert failed'),
    } as never);
    await expect(
      service.create({ cruxId: 'crux-1', reason: 'spam' }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('records the operator on a resolution and 404s for an unknown report', async () => {
    const { service, repository } = fixture();
    const updated = await service.update(
      'report-1',
      { status: 'dismissed', resolutionNote: 'Fine' },
      'operator-1',
    );
    expect(updated.status).toBe('dismissed');
    expect(repository.update).toHaveBeenCalledWith('report-1', {
      status: 'dismissed',
      resolutionNote: 'Fine',
      resolvedBy: 'operator-1',
    });

    repository.findById.mockResolvedValueOnce({
      data: undefined,
      error: null,
    } as never);
    await expect(
      service.update('nope', { status: 'resolved' }, 'operator-1'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('takes down through the crux service, then closes that crux’s open reports', async () => {
    const { service, repository, cruxService } = fixture();
    const takedown = await service.takeDown(
      { cruxId: 'crux-1', reason: 'Illegal', reportId: 'report-1' },
      'operator-1',
    );

    expect(takedown).toEqual({ id: 'takedown-1' });
    expect(cruxService.takeDownCrux).toHaveBeenCalledWith(
      'crux-1',
      'operator-1',
      'Illegal',
      'report-1',
    );
    expect(repository.resolveOpenForCrux).toHaveBeenCalledWith('crux-1', {
      status: 'resolved',
      resolutionNote: 'Taken down: Illegal',
      resolvedBy: 'operator-1',
    });
  });

  it('leaves reports open when the takedown itself fails, and keeps a takedown whose reports could not be closed', async () => {
    const { service, repository, cruxService } = fixture();
    cruxService.takeDownCrux.mockRejectedValueOnce(new Error('teardown'));
    await expect(
      service.takeDown({ cruxId: 'crux-1', reason: 'Illegal' }, 'operator-1'),
    ).rejects.toThrow('teardown');
    expect(repository.resolveOpenForCrux).not.toHaveBeenCalled();

    repository.resolveOpenForCrux.mockResolvedValueOnce({
      data: null,
      error: new Error('update failed'),
    } as never);
    await expect(
      service.takeDown({ cruxId: 'crux-1', reason: 'Illegal' }, 'operator-1'),
    ).resolves.toEqual({ id: 'takedown-1' });
  });

  describe('who hears about a report (CR08)', () => {
    it('REPORTS_NOTIFY_EMAIL wins, and may list several addresses', async () => {
      const { service, repository } = fixture();
      process.env.REPORTS_NOTIFY_EMAIL =
        'a@example.com, b@example.com, nonsense';
      process.env.BOOTSTRAP_ADMIN_EMAIL = 'op@example.com';
      expect(await service.recipients()).toEqual([
        'a@example.com',
        'b@example.com',
      ]);
      expect(repository.operatorEmails).not.toHaveBeenCalled();
    });

    it('falls back to the configured operator, then to admin accounts', async () => {
      const { service, repository, email } = fixture();
      process.env.BOOTSTRAP_ADMIN_EMAIL = 'op@example.com';
      expect(await service.recipients()).toEqual(['op@example.com']);

      delete process.env.BOOTSTRAP_ADMIN_EMAIL;
      repository.operatorEmails.mockResolvedValue({
        data: ['keeper@example.com'],
        error: null,
      });
      await service.create({ cruxId: 'crux-1', reason: 'illegal' });
      expect(email.send).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'keeper@example.com' }),
      );
    });

    it('warns at startup, naming the setting, only when nobody would hear', async () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const quiet = fixture();
        quiet.repository.operatorEmails.mockResolvedValue({
          data: ['keeper@example.com'],
          error: null,
        });
        await quiet.service.onApplicationBootstrap();
        expect(quiet.logger.warn).not.toHaveBeenCalled();

        const silent = fixture();
        silent.repository.operatorEmails.mockResolvedValue({
          data: null as never,
          error: new Error('db down'),
        });
        await silent.service.onApplicationBootstrap();
        expect(silent.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('REPORTS_NOTIFY_EMAIL'),
        );
      } finally {
        process.env.NODE_ENV = nodeEnv;
      }
    });
  });

  it('summarises open, recently closed and taken-down counts over 30 days', async () => {
    const { service, repository } = fixture();
    const now = new Date('2026-10-05T12:00:00Z');
    await expect(service.summary(now)).resolves.toEqual({
      open: 2,
      resolvedLast30d: 5,
      takenDown: 1,
    });
    expect(repository.summary.mock.calls[0][0].toISOString()).toBe(
      '2026-09-05T12:00:00.000Z',
    );
    repository.summary.mockResolvedValueOnce({
      data: null as never,
      error: new Error('x'),
    });
    await expect(service.summary(now)).rejects.toMatchObject({ status: 500 });
  });
});
