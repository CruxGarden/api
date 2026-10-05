import { InferenceAuthGuard } from './inference.controller';
import type { ExecutionContext } from '@nestjs/common';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
  InferenceService,
  STALE_RESERVATION_MS,
  attributedCrux,
  parseContextTokens,
} from './inference.service';
import {
  InferenceRepository,
  ReservationError,
  admit,
  usageTotals,
  UsageRow,
} from './inference.repository';
import { BillingService } from '../billing/billing.service';
import { LoggerService } from '../common/services/logger.service';
import {
  ALLOWANCES,
  SONNET,
  HOUR,
  MAX_OUTPUT,
  MIN_USEFUL_OUTPUT,
  admitOutput,
  cost,
  outputEstimate,
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
function fixture(plan = 'gardener', notifications?: unknown) {
  const repo = {
    rows: jest.fn().mockResolvedValue({ data: [], error: null }),
    reserve: jest.fn().mockResolvedValue({
      data: { model: SONNET, amount: 8000 },
      error: null,
    }),
    settle: jest.fn().mockResolvedValue({ data: true, error: null }),
    progress: jest.fn().mockResolvedValue({ data: true, error: null }),
    stale: jest.fn().mockResolvedValue({ data: [], error: null }),
    find: jest.fn(),
    adjust: jest.fn(),
  };
  const billing = {
    planIdFor: jest.fn().mockResolvedValue(plan),
    assertNotSuspended: jest.fn().mockResolvedValue(undefined),
  };
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
    notifications as never,
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
    expect(SONNET).toBe('claude-sonnet-5-5');
    const tokens = { input: 100, output: 50, cacheRead: 200, cacheWrite: 40 };
    expect(cost(SONNET, tokens)).toBe(840);
    expect(reservation(SONNET, 100, 1000)).toBeGreaterThan(6000);
  });
  it('rejects unsupported models, costly options, remote files and server tools', () => {
    for (const extra of [
      { model: 'claude-opus-5' },
      { max_tokens: 8193 },
      { temperature: 0.5 },
      { top_p: 0.7 },
      { tool_choice: { type: 'any' } },
      { tool_choice: { type: 'tool', name: 'write_file' } },
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
      840,
      { input: 100, output: 50, cacheRead: 200, cacheWrite: 40 },
      'complete',
    );
    expect(f.repo.settle).toHaveBeenCalledTimes(1);
    expect(f.res.write).toHaveBeenCalledWith(
      expect.stringContaining('event: message_stop'),
    );
    expect(f.provider.messages.create.mock.calls[0][0].model).toBe(SONNET);
  });
  it('runs both tiers on Sonnet and separates them by effort', async () => {
    const base = fixture();
    base.provider.messages.create.mockResolvedValue(completed());
    await base.service.stream('account', randomUUID(), request(), base.res);
    expect(
      base.repo.reserve.mock.calls[0][2].map((c: { model: string }) => c.model),
    ).toEqual([SONNET]);
    expect(base.provider.messages.create.mock.calls[0][0]).toMatchObject({
      model: SONNET,
      output_config: { effort: 'medium' },
    });

    const plus = fixture('gardener_plus');
    plus.provider.messages.create.mockResolvedValue(completed());
    await plus.service.stream('account', randomUUID(), request(), plus.res);
    expect(
      plus.repo.reserve.mock.calls[0][2].map((c: { model: string }) => c.model),
    ).toEqual([SONNET]);
    expect(plus.provider.messages.create.mock.calls[0][0]).toMatchObject({
      model: SONNET,
      output_config: { effort: 'high' },
    });
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
  it('charges a truncated stream its measured usage, not the reservation, and ends the response', async () => {
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
      cost(SONNET, { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 }),
      { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 },
      'interrupted',
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
        model: SONNET,
        status: 'uncertain',
        charged_microdollars: 50000,
        created: new Date(now.getTime() - HOUR),
      },
    ] as UsageRow[];
    f.repo.rows.mockResolvedValue({ data: rows, error: null });
    expect(usageTotals(rows, now)).toEqual({
      fiveHour: 50000,
      thirtyDay: 150000,
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

const start = {
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
const text = (t: string) => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text: t },
});
describe('Measured settlement of interrupted requests (ADR 0082)', () => {
  it('charges input, cache and an estimate of streamed output when the stream breaks', async () => {
    const f = fixture();
    f.provider.messages.create.mockResolvedValue(
      (async function* () {
        yield start;
        yield text('x'.repeat(300));
        throw new Error('connection reset');
      })(),
    );
    await f.service.stream('account', randomUUID(), request(), f.res);
    const measured = {
      input: 100,
      output: 100,
      cacheRead: 200,
      cacheWrite: 40,
    };
    expect(outputEstimate(300)).toBe(100);
    expect(f.repo.settle).toHaveBeenCalledWith(
      'account',
      expect.any(String),
      cost(SONNET, measured),
      measured,
      'interrupted',
    );
    expect(cost(SONNET, measured)).toBeLessThan(8000);
    expect(f.repo.settle).toHaveBeenCalledTimes(1);
    // Progress is recorded so a server death can still settle at measured usage.
    expect(f.repo.progress).toHaveBeenCalledWith(
      'account',
      expect.any(String),
      { input: 100, output: 1, cacheRead: 200, cacheWrite: 40 },
    );
    expect(f.res.write).toHaveBeenLastCalledWith(
      expect.stringContaining('event: error'),
    );
  });
  it('never charges more than the reservation', async () => {
    const f = fixture();
    f.provider.messages.create.mockResolvedValue(
      (async function* () {
        yield start;
        yield text('x'.repeat(30_000));
        throw new Error('connection reset');
      })(),
    );
    await f.service.stream('account', randomUUID(), request(), f.res);
    expect(f.repo.settle.mock.calls[0][2]).toBe(8000);
    expect(f.repo.settle.mock.calls[0][4]).toBe('interrupted');
  });
  it("prefers the provider's output count once message_delta has arrived", async () => {
    const f = fixture();
    f.provider.messages.create.mockResolvedValue(
      (async function* () {
        yield start;
        yield text('x'.repeat(3000));
        yield { type: 'message_delta', usage: { output_tokens: 7 } };
        throw new Error('lost before message_stop');
      })(),
    );
    await f.service.stream('account', randomUUID(), request(), f.res);
    expect(f.repo.settle.mock.calls[0][3]).toEqual({
      input: 100,
      output: 7,
      cacheRead: 200,
      cacheWrite: 40,
    });
  });
  it('settles a person stopping mid-reply at measured usage and aborts upstream', async () => {
    const f = fixture();
    let streaming!: () => void;
    const midway = new Promise<void>((r) => (streaming = r));
    let aborted = false;
    f.provider.messages.create.mockImplementation(
      (_body: unknown, options: { signal: AbortSignal }) =>
        (async function* () {
          yield start;
          yield text('x'.repeat(30));
          streaming();
          await new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            }),
          );
        })(),
    );
    const pending = f.service.stream('account', randomUUID(), request(), f.res);
    await midway;
    Object.assign(f.res, { destroyed: true });
    (f.res as unknown as EventEmitter).emit('close');
    await pending;
    expect(aborted).toBe(true);
    expect(f.repo.settle).toHaveBeenCalledWith(
      'account',
      expect.any(String),
      cost(SONNET, { input: 100, output: 10, cacheRead: 200, cacheWrite: 40 }),
      { input: 100, output: 10, cacheRead: 200, cacheWrite: 40 },
      'interrupted',
    );
  });
});
describe('Clamp instead of refuse (ADR 0082)', () => {
  it('admits the largest output that fits, and refuses only when the minimum does not', () => {
    const input = 50_000;
    const full = reservation(SONNET, input, MAX_OUTPUT);
    const minimum = reservation(SONNET, input, MIN_USEFUL_OUTPUT);
    expect(admitOutput(SONNET, input, MAX_OUTPUT, full)).toBe(MAX_OUTPUT);
    const remaining = Math.floor((full + minimum) / 2);
    const out = admitOutput(SONNET, input, MAX_OUTPUT, remaining)!;
    expect(out).toBeGreaterThan(MIN_USEFUL_OUTPUT);
    expect(out).toBeLessThan(MAX_OUTPUT);
    expect(reservation(SONNET, input, out)).toBeLessThanOrEqual(remaining);
    expect(reservation(SONNET, input, out + 1)).toBeGreaterThan(remaining);
    expect(admitOutput(SONNET, input, MAX_OUTPUT, minimum - 1)).toBeNull();
    // A smaller requested budget is its own minimum and is never raised.
    expect(admitOutput(SONNET, 0, 500, 1_000_000)).toBe(500);
    expect(admitOutput(SONNET, 0, 500, reservation(SONNET, 0, 499))).toBeNull();

    const choice = { model: SONNET, amount: full, input, output: MAX_OUTPUT };
    expect(admit([choice], full)).toEqual({
      model: SONNET,
      amount: full,
      maxTokens: MAX_OUTPUT,
    });
    expect(admit([choice], remaining)).toEqual({
      model: SONNET,
      amount: reservation(SONNET, input, out),
      maxTokens: out,
    });
    expect(admit([choice], minimum - 1)).toBeNull();
    // Fixed-price choices (images) never clamp.
    expect(admit([{ model: 'image', amount: 500_000 }], 499_999)).toBeNull();
  });
  it('offers the counted input and requested output to the reservation, and sends the clamped budget upstream', async () => {
    const f = fixture();
    f.repo.reserve.mockResolvedValue({
      data: { model: SONNET, amount: 5000, maxTokens: 400 },
      error: null,
    });
    f.provider.messages.create.mockResolvedValue(completed());
    await f.service.stream('account', randomUUID(), request(), f.res);
    expect(f.repo.reserve.mock.calls[0][2]).toEqual([
      {
        model: SONNET,
        amount: reservation(SONNET, 100, 1000),
        input: 100,
        output: 1000,
      },
    ]);
    expect(f.provider.messages.create.mock.calls[0][0].max_tokens).toBe(400);
    expect(f.res.setHeader).toHaveBeenCalledWith(
      'X-Included-Max-Tokens',
      '400',
    );
  });
  it('refuses in plain words when even a short reply does not fit', async () => {
    const f = fixture();
    f.repo.reserve.mockResolvedValue({
      data: null,
      error: new ReservationError('allowance'),
    });
    const refusal = await f.service
      .stream('account', randomUUID(), request(), f.res)
      .catch((e: { status: number; message: string }) => e);
    expect(refusal).toMatchObject({ status: 429 });
    expect((refusal as unknown as Error).message).toMatch(
      /included collaboration/,
    );
    expect((refusal as unknown as Error).message).not.toMatch(/\bAI\b/);
  });
});
describe('Usage: next request and per-Crux attribution (ADR 0082)', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const row = (over: Partial<UsageRow>): UsageRow => ({
    id: randomUUID(),
    model: SONNET,
    status: 'complete',
    kind: 'chat',
    crux_id: null,
    charged_microdollars: 0,
    created: new Date(now.getTime() - 6 * HOUR),
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    ...over,
  });
  it('answers whether the next request fits, by the admission math', async () => {
    const f = fixture('gardener');
    const context = 50_000;
    const minimum = reservation(SONNET, context, MIN_USEFUL_OUTPUT);
    const full = reservation(SONNET, context, MAX_OUTPUT);
    const remaining = Math.floor((minimum + full) / 2);
    f.repo.rows.mockResolvedValue({
      data: [
        row({
          charged_microdollars: ALLOWANCES.gardener.fiveHour - remaining,
          created: new Date(now.getTime() - HOUR),
        }),
      ],
      error: null,
    });
    const usage = await f.service.usage('account', now, context);
    expect(usage.nextRequest).toEqual({
      contextTokens: context,
      minimumMicrodollars: minimum,
      fits: true,
      fullLengthFits: false,
    });
    const tooLong = await f.service.usage('account', now, 100_001);
    expect(tooLong.nextRequest).toMatchObject({ fits: false });
    const free = fixture('free');
    expect((await free.service.usage('account', now, 0)).nextRequest).toEqual({
      contextTokens: 0,
      minimumMicrodollars: reservation(SONNET, 0, MIN_USEFUL_OUTPUT),
      fits: false,
      fullLengthFits: false,
    });
  });
  it('assumes the median prompt of the last ten completed chats, or reports none', async () => {
    const f = fixture('gardener_plus');
    const prompts = [10, 30, 20, 99_999].map((n, i) =>
      row({
        input_tokens: n - 2,
        cache_read_tokens: 1,
        cache_write_tokens: 1,
        status: i === 3 ? 'uncertain' : 'complete',
      }),
    );
    f.repo.rows.mockResolvedValue({ data: prompts, error: null });
    const usage = await f.service.usage('account', now);
    expect(usage.nextRequest.contextTokens).toBe(20);
    expect(usage.nextRequest.minimumMicrodollars).toBe(
      reservation(SONNET, 20, MIN_USEFUL_OUTPUT),
    );
    expect(usage.nextRequest.fits).toBe(true);
    expect(usage.nextRequest.fullLengthFits).toBe(true);
    f.repo.rows.mockResolvedValue({ data: [], error: null });
    expect((await f.service.usage('account', now)).nextRequest).toMatchObject({
      contextTokens: null,
      minimumMicrodollars: reservation(SONNET, 0, MIN_USEFUL_OUTPUT),
    });
  });
  it('groups 30-day spend by Crux and kind, largest first, and labels each recent request', async () => {
    const f = fixture('gardener');
    const a = randomUUID();
    f.repo.rows.mockResolvedValue({
      data: [
        row({ crux_id: a, charged_microdollars: 300 }),
        row({ crux_id: a, kind: 'image', charged_microdollars: 600 }),
        row({ crux_id: a, charged_microdollars: '200' }),
        row({ crux_id: null, charged_microdollars: 100 }),
        row({ crux_id: a, status: 'rejected', charged_microdollars: 0 }),
      ],
      error: null,
    });
    const usage = await f.service.usage('account', now);
    expect(usage.byCrux).toEqual([
      { cruxId: a, kind: 'image', microdollars: 600, requests: 1 },
      { cruxId: a, kind: 'chat', microdollars: 500, requests: 2 },
      { cruxId: null, kind: 'chat', microdollars: 100, requests: 1 },
    ]);
    expect(usage.recentRequests.map((r) => r.kind)).toEqual([
      'chat',
      'chat',
      'chat',
      'image',
      'chat',
    ]);
  });
  it('accepts only a UUID crux label and a whole-number context, and stores the label', async () => {
    const id = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
    expect(attributedCrux(id)).toBe(id.toLowerCase());
    for (const bad of [undefined, '', 'crux', `${id}x`, ['a'], 42])
      expect(attributedCrux(bad)).toBeNull();
    expect(parseContextTokens(undefined)).toBeUndefined();
    expect(parseContextTokens('')).toBeUndefined();
    expect(parseContextTokens('12000')).toBe(12000);
    for (const bad of ['-1', '1.5', 'abc', '1e5', '1234567890'])
      expect(() => parseContextTokens(bad)).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    const f = fixture();
    f.provider.messages.create.mockResolvedValue(completed());
    await f.service.stream(
      'account',
      randomUUID(),
      request(),
      f.res,
      attributedCrux(id),
    );
    expect(f.repo.reserve.mock.calls[0][5]).toEqual({
      cruxId: id.toLowerCase(),
      kind: 'chat',
    });
  });
});
describe('Stale reservations and operator adjustment (ADR 0082)', () => {
  it('settles dead reservations at measured usage, else releases them as abandoned', async () => {
    const f = fixture();
    const now = new Date('2026-10-05T12:00:00Z');
    const base = {
      model: SONNET,
      status: 'reserved',
      reserved_microdollars: '8000',
      charged_microdollars: '8000',
      created: new Date(now.getTime() - HOUR),
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
    };
    f.repo.stale.mockResolvedValue({
      data: [
        {
          ...base,
          id: 'measured',
          account_id: 'a1',
          input_tokens: 100,
          output_tokens: 1,
          cache_read_tokens: 200,
          cache_write_tokens: 40,
        },
        { ...base, id: 'unknown', account_id: 'a2', input_tokens: null },
        {
          ...base,
          id: 'huge',
          account_id: 'a3',
          input_tokens: 1_000_000,
        },
      ],
      error: null,
    });
    expect(await f.service.sweep(now)).toEqual({
      interrupted: 2,
      abandoned: 1,
    });
    expect(f.repo.stale).toHaveBeenCalledWith(
      new Date(now.getTime() - STALE_RESERVATION_MS),
    );
    const measured = { input: 100, output: 1, cacheRead: 200, cacheWrite: 40 };
    expect(f.repo.settle).toHaveBeenCalledWith(
      'a1',
      'measured',
      cost(SONNET, measured),
      measured,
      'interrupted',
    );
    expect(f.repo.settle).toHaveBeenCalledWith(
      'a2',
      'unknown',
      0,
      null,
      'abandoned',
    );
    expect(f.repo.settle.mock.calls[2][2]).toBe(8000);
  });
  it('lets an operator lower a settled charge, never raise it, and logs it', async () => {
    const f = fixture();
    const settled = {
      id: 'r1',
      account_id: 'a1',
      model: SONNET,
      status: 'uncertain',
      charged_microdollars: '5000',
    };
    f.repo.find.mockResolvedValue({ data: settled, error: null });
    f.repo.adjust.mockResolvedValue({
      data: {
        ...settled,
        charged_microdollars: '1000',
        adjusted_from_microdollars: '5000',
      },
      error: null,
    });
    await expect(
      f.service.adjust('admin', 'r1', 1000, ' refund '),
    ).resolves.toEqual({
      id: 'r1',
      status: 'uncertain',
      chargedMicrodollars: 1000,
      adjustedFromMicrodollars: 5000,
      reason: 'refund',
    });
    expect(f.repo.adjust).toHaveBeenCalledWith('r1', 1000, 'refund', 'admin');
    for (const higher of [5000, 6000])
      await expect(
        f.service.adjust('admin', 'r1', higher, 'x'),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.service.adjust('admin', 'r1', -1, 'x'),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      f.service.adjust('admin', 'r1', 10, '  '),
    ).rejects.toMatchObject({
      status: 400,
    });
    f.repo.find.mockResolvedValue({
      data: { ...settled, status: 'reserved' },
      error: null,
    });
    await expect(
      f.service.adjust('admin', 'r1', 10, 'x'),
    ).rejects.toMatchObject({
      status: 409,
    });
    f.repo.find.mockResolvedValue({ data: null, error: null });
    await expect(
      f.service.adjust('admin', 'r1', 10, 'x'),
    ).rejects.toMatchObject({
      status: 404,
    });
    f.repo.find.mockResolvedValue({ data: settled, error: null });
    f.repo.adjust.mockResolvedValue({ data: null, error: null });
    await expect(
      f.service.adjust('admin', 'r1', 10, 'x'),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(f.repo.adjust).toHaveBeenCalledTimes(2);
  });
  it('hands the settled 30-day window to the allowance notices', async () => {
    const notifications = {
      afterIncludedUsage: jest.fn().mockResolvedValue(null),
    };
    const f = fixture('gardener', notifications);
    f.repo.rows.mockResolvedValue({
      data: [
        {
          id: 'x',
          model: SONNET,
          status: 'complete',
          charged_microdollars: 3_200_000,
          created: new Date(),
        },
      ],
      error: null,
    });
    f.provider.messages.create.mockResolvedValue(completed());
    await f.service.stream('account', randomUUID(), request(), f.res);
    await new Promise((r) => setImmediate(r));
    expect(notifications.afterIncludedUsage).toHaveBeenCalledWith(
      'account',
      expect.objectContaining({
        planName: 'Gardener',
        usedMicrodollars: 3_200_000,
        limitMicrodollars: ALLOWANCES.gardener.thirtyDay,
      }),
      expect.any(Date),
    );
  });
});
