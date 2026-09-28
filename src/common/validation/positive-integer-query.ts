import { BadRequestException } from '@nestjs/common';

/** Query values must be one complete integer, not arrays or parseInt prefixes. */
export function positiveIntegerQuery(
  value: unknown,
  name: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
  return number;
}
