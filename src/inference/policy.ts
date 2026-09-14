import { BadRequestException } from '@nestjs/common';
export const HAIKU = 'claude-haiku-4-5-20251001';
export const SONNET = 'claude-sonnet-5';
export const HOUR = 3_600_000;
export interface Allowance {
  fiveHour: number;
  thirtyDay: number;
  premiumFiveHour: number;
}
/** Microdollars, independent of monthly/annual Stripe renewal dates. */
export const ALLOWANCES: Record<string, Allowance> = {
  gardener: { fiveHour: 750_000, thirtyDay: 4_000_000, premiumFiveHour: 0 },
  gardener_plus: {
    fiveHour: 2_000_000,
    thirtyDay: 8_000_000,
    premiumFiveHour: 1_500_000,
  },
};
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export function cost(model: string, t: Tokens): number {
  const input = model === SONNET ? 2 : 1;
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
  if (!['garden-included', HAIKU, SONNET].includes(String(body.model)))
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
