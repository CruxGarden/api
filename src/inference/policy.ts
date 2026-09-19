import { BadRequestException } from '@nestjs/common';
/**
 * Both tiers run Claude Sonnet 5. They differ by allowance and by effort, not
 * by model: Sonnet is twice Haiku's price but has a 1M context instead of
 * 200K, supports effort (Haiku 4.5 does not), and its retirement commitment
 * runs to 2027-06-30 where Haiku 4.5's window opens 2026-10-15. One model also
 * means one prompt-cache namespace — the old Sonnet→Haiku fallback threw the
 * cache away exactly when an account was running low, which is the worst
 * moment to start paying full input price.
 */
export const SONNET = 'claude-sonnet-5';
export const HOUR = 3_600_000;
/**
 * Effort is the per-tier cost lever that a second, weaker model used to be.
 * Lower effort means less thinking and fewer, more consolidated tool calls.
 */
export const EFFORT: Record<string, 'low' | 'medium' | 'high'> = {
  gardener: 'medium',
  gardener_plus: 'high',
};
export interface Allowance {
  fiveHour: number;
  thirtyDay: number;
}
/** Microdollars, independent of monthly/annual Stripe renewal dates. */
export const ALLOWANCES: Record<string, Allowance> = {
  gardener: { fiveHour: 750_000, thirtyDay: 4_000_000 },
  gardener_plus: { fiveHour: 2_000_000, thirtyDay: 8_000_000 },
};
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
/**
 * Microdollars for one request. `input` is the model's dollars per million
 * input tokens; output is 5x input, a cache read a tenth, a cache write 1.25x
 * — the same ratios across the current Claude lineup. Verified 2026-09-18:
 * Sonnet 5 is $2 in / $10 out per MTok.
 */
const INPUT_PRICE: Record<string, number> = { [SONNET]: 2 };
export function cost(model: string, t: Tokens): number {
  const input = INPUT_PRICE[model] ?? 2;
  return Math.ceil(
    input * (t.input + t.output * 5 + t.cacheRead / 10 + t.cacheWrite * 1.25),
  );
}
export function reservation(
  model: string,
  input: number,
  output: number,
): number {
  // Count Tokens is an estimate; allow 20% + 1,024 tokens of overhead and assume cache writes.
  return cost(model, {
    input: 0,
    output,
    cacheRead: 0,
    cacheWrite: Math.ceil(input * 1.2) + 1024,
  });
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function validateRequest(value: unknown): Record<string, unknown> {
  const fail = (message: string): never => {
    throw new BadRequestException(message);
  };
  if (!object(value) || Buffer.byteLength(JSON.stringify(value)) > 4_000_000)
    fail('Use a model request up to 4 MB.');
  const body = value as Record<string, unknown>;
  const allowed = [
    'model',
    'messages',
    'system',
    'tools',
    'tool_choice',
    'stream',
    'max_tokens',
    'temperature',
    'top_p',
    'stop_sequences',
  ];
  if (Object.keys(body).some((k) => !allowed.includes(k)))
    fail('Unsupported included collaborator request option.');
  if (!['garden-included', SONNET].includes(String(body.model)))
    fail('Choose the included collaborator.');
  if (
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.length > 300
  )
    fail('Use between 1 and 300 messages.');
  if (
    !Number.isInteger(body.max_tokens) ||
    Number(body.max_tokens) < 1 ||
    Number(body.max_tokens) > 8192
  )
    fail('Use an output budget between 1 and 8,192 tokens.');
  if (body.stream !== true) fail('Included collaboration requires streaming.');
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.length > 256 ||
      body.tools.some(
        (t) =>
          !object(t) ||
          t.type !== undefined ||
          typeof t.name !== 'string' ||
          !object(t.input_schema),
      ))
  )
    fail('Use local custom tools only.');
  // Validate protocol blocks, not arbitrary tool arguments or JSON schemas.
  const inspect = (v: unknown, depth = 0) => {
    if (depth > 80) fail('The request is too deeply nested.');
    if (Array.isArray(v)) for (const x of v) inspect(x, depth + 1);
    else if (object(v)) for (const x of Object.values(v)) inspect(x, depth + 1);
  };
  const cache = (v: Record<string, unknown>) => {
    if (
      v.cache_control !== undefined &&
      (!object(v.cache_control) ||
        v.cache_control.type !== 'ephemeral' ||
        (v.cache_control.ttl !== undefined && v.cache_control.ttl !== '5m'))
    )
      fail('Only five-minute prompt caching is supported.');
  };
  const content = (v: unknown) => {
    if (typeof v === 'string') return;
    if (!Array.isArray(v)) fail('Use text or an array of content blocks.');
    for (const block of v as unknown[]) {
      if (!object(block)) fail('Invalid content block.');
      const b = block as Record<string, unknown>;
      if (
        ![
          'text',
          'image',
          'document',
          'tool_use',
          'tool_result',
          'thinking',
          'redacted_thinking',
        ].includes(String(b.type))
      )
        fail('Unsupported content block.');
      cache(b);
      if (b.type === 'image' || b.type === 'document') {
        if (
          !object(b.source) ||
          !['base64', 'text'].includes(String(b.source.type))
        )
          fail(
            'Include media bytes directly rather than provider file or URL references.',
          );
      }
      if (b.type === 'tool_result' && b.content !== undefined)
        content(b.content);
    }
  };
  inspect(body);
  for (const message of body.messages as unknown[]) {
    if (
      !object(message) ||
      !['user', 'assistant'].includes(String(message.role))
    )
      fail('Invalid message role.');
    content((message as Record<string, unknown>).content);
  }
  if (body.system !== undefined) content(body.system);
  for (const tool of (body.tools ?? []) as Record<string, unknown>[])
    cache(tool);
  return body;
}
