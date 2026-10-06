import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import type { Response } from 'express';
import { IncludedImageService } from './image.service';
import {
  IMAGE_MODEL,
  IMAGE_OUTPUT_TOKENS,
  IMAGE_REFERENCE_TOKENS,
  IMAGE_RESERVATION,
  imageCost,
  imageEstimate,
  validateImageRequest,
} from './image-policy';
import { InferenceRepository, ReservationError } from './inference.repository';
import { BillingService } from '../billing/billing.service';
import { LoggerService } from '../common/services/logger.service';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
const request = { prompt: 'A garden banner', size: '1024x1024' };
const usage = {
  input_tokens: 120,
  input_tokens_details: { text_tokens: 100, image_tokens: 20 },
  output_tokens: 1000,
};
function fixture(plan = 'gardener') {
  const repo = {
    reserve: jest.fn().mockResolvedValue({
      data: { model: IMAGE_MODEL, amount: IMAGE_RESERVATION },
      error: null,
    }),
    settle: jest.fn().mockResolvedValue({ data: true, error: null }),
  };
  const provider = {
    images: {
      generate: jest
        .fn()
        .mockResolvedValue({ data: [{ b64_json: png }], usage }),
      edit: jest.fn().mockResolvedValue({ data: [{ b64_json: png }], usage }),
    },
  };
  const service = new IncludedImageService(
    repo as unknown as InferenceRepository,
    {
      planIdFor: async () => plan,
      assertNotSuspended: async () => undefined,
    } as unknown as BillingService,
    new LoggerService(),
  );
  jest.spyOn(service as any, 'provider').mockReturnValue(provider);
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    setHeader: jest.fn(),
    json: jest.fn(),
  });
  return { repo, provider, service, res: res as unknown as Response };
}
it('generates and edits with a reserved account allowance, returning real image bytes', async () => {
  const f = fixture();
  const id = randomUUID();
  await f.service.generate('account', id, request, f.res);
  expect(f.repo.reserve).toHaveBeenCalledWith(
    'account',
    id,
    [{ model: IMAGE_MODEL, amount: IMAGE_RESERVATION }],
    expect.any(Object),
    expect.any(Date),
    { cruxId: null, kind: 'image' },
  );
  expect(f.res.json).toHaveBeenCalledWith({
    image: png,
    mimeType: 'image/png',
    model: IMAGE_MODEL,
    requestId: id,
  });
  expect(f.repo.settle).toHaveBeenCalledWith(
    'account',
    id,
    30660,
    { input: 120, output: 1000, cacheRead: 0, cacheWrite: 0 },
    'complete',
  );
  await f.service.generate(
    'account',
    randomUUID(),
    { ...request, image: png },
    f.res,
  );
  expect(f.provider.images.edit).toHaveBeenCalledWith(
    expect.objectContaining({
      image: expect.anything(),
      quality: 'medium',
      n: 1,
    }),
    expect.anything(),
  );
});
it('refuses free plans, malformed input and duplicate requests before provider generation', async () => {
  const f = fixture('free');
  await expect(
    f.service.generate('account', randomUUID(), request, f.res),
  ).rejects.toMatchObject({ status: 402 });
  expect(f.repo.reserve).not.toHaveBeenCalled();
  expect(() =>
    validateImageRequest({
      ...request,
      image: 'https://private.example/image.png',
    }),
  ).toThrow();
  expect(() =>
    validateImageRequest({ ...request, prompt: 'x'.repeat(4001) }),
  ).toThrow();
  expect(() => validateImageRequest({ ...request, n: 100 })).toThrow();
  const g = fixture();
  g.repo.reserve.mockResolvedValue({
    data: null,
    error: new ReservationError('duplicate'),
  } as never);
  await expect(
    g.service.generate('account', randomUUID(), request, g.res),
  ).rejects.toMatchObject({ status: 409 });
  expect(g.provider.images.generate).not.toHaveBeenCalled();
});
it('retains uncertain allowance on transport failure and releases it on explicit rejection', async () => {
  const f = fixture();
  const id = randomUUID();
  f.provider.images.generate.mockRejectedValue(new Error('timeout'));
  await expect(
    f.service.generate('account', id, request, f.res),
  ).rejects.toThrow('may have used allowance');
  expect(f.repo.settle).toHaveBeenCalledWith(
    'account',
    id,
    IMAGE_RESERVATION,
    null,
    'uncertain',
  );
  f.provider.images.generate.mockRejectedValue(
    new OpenAI.APIError(400, {}, 'rejected', new Headers()),
  );
  await expect(
    f.service.generate('account', id, request, f.res),
  ).rejects.toThrow('No image allowance was used');
  expect(f.repo.settle).toHaveBeenLastCalledWith(
    'account',
    id,
    0,
    null,
    'rejected',
  );
});
it('aborts the provider on disconnect, keeps unknown usage reserved, and never emits a result', async () => {
  const f = fixture();
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  f.provider.images.generate.mockImplementation(
    (_body: unknown, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
        started();
      }),
  );
  const pending = f.service.generate('account', randomUUID(), request, f.res);
  await ready;
  Object.assign(f.res, { destroyed: true });
  f.res.emit('close');
  await pending;
  expect(f.res.json).not.toHaveBeenCalled();
  expect(f.repo.settle).toHaveBeenCalledWith(
    'account',
    expect.any(String),
    IMAGE_RESERVATION,
    null,
    'uncertain',
  );
});
it('does not invent exact usage when token detail is absent or inconsistent', () => {
  expect(imageCost(null)).toBeNull();
  expect(imageCost({ ...usage, input_tokens: 999 })).toBeNull();
  expect(imageCost({ ...usage, output_tokens: -1 })).toBeNull();
});

it('charges the documented size estimate, not the reservation, when a successful response omits usage', async () => {
  const f = fixture();
  f.provider.images.generate.mockResolvedValue({ data: [{ b64_json: png }] });
  const id = randomUUID();
  await f.service.generate('account', id, request, f.res);
  const estimate = imageEstimate(request as never);
  // 'A garden banner' is 15 bytes → 8 text tokens; medium square is 1,056 output tokens.
  expect(estimate).toEqual({
    amount: 8 * 5 + IMAGE_OUTPUT_TOKENS['1024x1024'] * 30,
    input: 8,
    output: 1056,
  });
  expect(f.repo.settle).toHaveBeenCalledWith(
    'account',
    id,
    estimate.amount,
    { input: 8, output: 1056, cacheRead: 0, cacheWrite: 0 },
    'estimated',
  );
  expect(estimate.amount).toBeLessThan(IMAGE_RESERVATION / 10);
  expect(f.res.json).toHaveBeenCalled();
});
it('scales the estimate with size and a reference image, and never exceeds the reservation', () => {
  const portrait = imageEstimate({ prompt: 'x', size: '1024x1536' });
  expect(portrait.output).toBe(1584);
  const edit = imageEstimate({ prompt: 'x', size: '1024x1536', image: png });
  expect(edit.input).toBe(1 + IMAGE_REFERENCE_TOKENS);
  expect(edit.amount - portrait.amount).toBe(IMAGE_REFERENCE_TOKENS * 8);
  expect(
    imageEstimate({ prompt: 'x'.repeat(4000), size: '1536x1024', image: png })
      .amount,
  ).toBeLessThanOrEqual(IMAGE_RESERVATION);
});
it('estimates a provider answer that carried no usable image, rather than retaining the reservation', async () => {
  const f = fixture();
  f.provider.images.generate.mockResolvedValue({ data: [] });
  await expect(
    f.service.generate('account', randomUUID(), request, f.res),
  ).rejects.toMatchObject({ status: 503 });
  expect(f.repo.settle.mock.calls[0][4]).toBe('estimated');
  expect(f.repo.settle.mock.calls[0][2]).toBe(
    imageEstimate(request as never).amount,
  );
});
it('labels the image ledger row with the crux it served', async () => {
  const f = fixture();
  const cruxId = randomUUID();
  await f.service.generate('account', randomUUID(), request, f.res, cruxId);
  expect(f.repo.reserve.mock.calls[0][5]).toEqual({ cruxId, kind: 'image' });
});
