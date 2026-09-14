import { InferenceAuthGuard } from './inference.controller';
import type { ExecutionContext } from '@nestjs/common';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { InferenceService } from './inference.service';
import {
  InferenceRepository,
  ReservationError,
  usageTotals,
  UsageRow,
} from './inference.repository';
import { BillingService } from '../billing/billing.service';
import { LoggerService } from '../common/services/logger.service';
import {
  ALLOWANCES,
  HAIKU,
  SONNET,
  HOUR,
  cost,
  reservation,
  validateRequest,
} from './policy';
import type { Response } from 'express';
const request = () => ({
  model: 'garden-included',
  messages: [{ role: 'user', content: 'Make a page' }],
  max_tokens: 1000,
  stream: true,
});
function fixture(plan = 'gardener') {
  const repo = {
    rows: jest.fn().mockResolvedValue({ data: [], error: null }),
    reserve: jest
      .fn()
      .mockResolvedValue({ data: { model: HAIKU, amount: 8000 }, error: null }),
    settle: jest.fn().mockResolvedValue({ data: true, error: null }),
  };
  const billing = { planIdFor: jest.fn().mockResolvedValue(plan) };
  const provider = {
    messages: {
      countTokens: jest.fn().mockResolvedValue({ input_tokens: 100 }),
      create: jest.fn(),
    },
  };
  const service = new InferenceService(
    repo as unknown as InferenceRepository,
    billing as unknown as BillingService,
    new LoggerService(),
  );
  jest.spyOn(service as any, 'provider').mockReturnValue(provider);
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn(),
    flushHeaders() {
      this.headersSent = true;
    },
    end() {
      this.writableEnded = true;
    },
  });
  return { repo, billing, provider, service, res: res as unknown as Response };
}
async function* completed() {
  yield {
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 100,
        output_tokens: 1,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 40,
      },
    },
  };
  yield { type: 'message_delta', usage: { output_tokens: 50 } };
  yield { type: 'message_stop' };
}
describe('Included request policy', () => {
  it('prices cache creation and reads independently, with conservative reservation', () => {
    const tokens = { input: 100, output: 50, cacheRead: 200, cacheWrite: 40 };
    expect(cost(HAIKU, tokens)).toBe(420);
    expect(cost(SONNET, tokens)).toBe(840);
    expect(reservation(HAIKU, 100, 1000)).toBeGreaterThan(6000);
  });
  it('rejects unsupported models, costly options, remote files and server tools', () => {
    for (const extra of [
      { model: 'claude-opus-5' },
      { max_tokens: 8193 },
      { stream: false },
      { thinking: { type: 'enabled' } },
      { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'url', url: 'https://example.org/a.png' },
              },
            ],
          },
        ],
      },
      {
        system: [
          {
            type: 'text',
            text: 'system',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    ])
      expect(() => validateRequest({ ...request(), ...extra })).toThrow();
  });
  it('accepts ordinary tool data named source or cache_control without mistaking it for protocol', () => {
    expect(() =>
      validateRequest({
        ...request(),
        tools: [
          {
            name: 'local',
            input_schema: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                cache_control: { type: 'string' },
              },
            },
          },
        ],
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: '1',
                name: 'local',
                input: {
                  source: { type: 'url' },
                  cache_control: { ttl: '1h' },
                },
              },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });
});
describe('Included streaming and accounting', () => {
  it('rejects free entitlement before counting or reserving', async () => {
    const f = fixture('free');
    await expect(
      f.service.stream('account', randomUUID(), request(), f.res),
    ).rejects.toMatchObject({ status: 402 });
    expect(f.provider.messages.countTokens).not.toHaveBeenCalled();
    expect(f.repo.reserve).not.toHaveBeenCalled();
  });
  it('settles once using provider counts, and forwards native SSE to the client', async () => {
    const f = fixture();
    f.provider.messages.create.mockResolvedValue(completed());
    const id = randomUUID();
    await f.service.stream('account', id, request(), f.res);
    expect(f.repo.settle).toHaveBeenCalledWith(
      'account',
      id,
      420,
      { input: 100, output: 50, cacheRead: 200, cacheWrite: 40 },
      'complete',
    );
    expect(f.repo.settle).toHaveBeenCalledTimes(1);
    expect(f.res.write).toHaveBeenCalledWith(
      expect.stringContaining('event: message_stop'),
    );
    expect(f.provider.messages.create.mock.calls[0][0].model).toBe(HAIKU);
  });
  it('gives Plus the ordered Sonnet/Haiku choices and honors the reserved fallback', async () => {
    const f = fixture('gardener_plus');
    f.provider.messages.create.mockResolvedValue(completed());
    await f.service.stream('account', randomUUID(), request(), f.res);
    expect(
      f.repo.reserve.mock.calls[0][2].map((c: { model: string }) => c.model),
    ).toEqual([SONNET, HAIKU]);
    expect(f.provider.messages.create.mock.calls[0][0].model).toBe(HAIKU);
  });
  it('retains the reservation after unknown transport failure rather than inventing zero usage', async () => {
    const f = fixture();
    f.provider.messages.create.mockRejectedValue(new Error('network failure'));
    await expect(
      f.service.stream('account', randomUUID(), request(), f.res),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.repo.settle).toHaveBeenCalledWith(
      'account',
      expect.any(String),
      8000,
      null,
      'uncertain',
    );
  });
  it('releases allowance for a provider HTTP rejection before streaming', async () => {
    const f = fixture();
    f.provider.messages.create.mockRejectedValue(
      new Anthropic.APIError(429, undefined, 'too busy', new Headers()),
    );
    await expect(
      f.service.stream('account', randomUUID(), request(), f.res),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.repo.settle).toHaveBeenCalledWith(
      'account',
      expect.any(String),
      0,
      null,
      'rejected',
    );
  });
  it('retains allowance for a truncated stream and ends the response', async () => {
    const f = fixture();
    f.provider.messages.create.mockResolvedValue(
      (async function* () {
        yield {
          type: 'message_start',
          message: { usage: { input_tokens: 100, output_tokens: 1 } },
        };
      })(),
    );
    await f.service.stream('account', randomUUID(), request(), f.res);
    expect(f.repo.settle).toHaveBeenCalledWith(
      'account',
      expect.any(String),
      8000,
      null,
      'uncertain',
    );
    expect(f.res.writableEnded).toBe(true);
  });
  it('does not call the provider or settle a rejected reservation', async () => {
    const f = fixture();
    f.repo.reserve.mockResolvedValue({
      data: null,
      error: new ReservationError('allowance'),
    });
    await expect(
      f.service.stream('account', randomUUID(), request(), f.res),
    ).rejects.toMatchObject({ status: 429 });
    expect(f.provider.messages.create).not.toHaveBeenCalled();
    expect(f.repo.settle).not.toHaveBeenCalled();
  });
  it('keeps windows rolling across billing renewals and exposes uncertainty and next release', async () => {
    const f = fixture('gardener_plus');
    const now = new Date('2026-09-14T20:00:00Z');
    const rows = [
      {
        model: SONNET,
        status: 'complete',
        charged_microdollars: 100000,
        created: new Date(now.getTime() - 6 * HOUR),
      },
      {
        model: HAIKU,
        status: 'uncertain',
        charged_microdollars: 50000,
        created: new Date(now.getTime() - HOUR),
      },
    ] as UsageRow[];
    f.repo.rows.mockResolvedValue({ data: rows, error: null });
    expect(usageTotals(rows, now)).toEqual({
      fiveHour: 50000,
      thirtyDay: 150000,
      premiumFiveHour: 0,
    });
    const usage = await f.service.usage('account', now);
    expect(usage.windows[0].nextReleaseAt).toBe('2026-09-15T00:00:00.000Z');
    expect(usage.windows[1].limitMicrodollars).toBe(
      ALLOWANCES.gardener_plus.thirtyDay,
    );
    expect(usage.uncertainRequests).toBe(1);
  });
});

describe('Included authentication boundary', () => {
  it('rejects the nursery anonymous shortcut even when nursery mode is enabled', async () => {
    const prior = process.env.NURSERY_MODE;
    process.env.NURSERY_MODE = 'true';
    try {
      const guard = new InferenceAuthGuard(new LoggerService());
      await expect(
        guard.canActivate({
          switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
        } as ExecutionContext),
      ).rejects.toMatchObject({ status: 401 });
    } finally {
      if (prior === undefined) delete process.env.NURSERY_MODE;
      else process.env.NURSERY_MODE = prior;
    }
  });
});
