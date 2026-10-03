import { BadRequestException } from '@nestjs/common';

export const IMAGE_MODEL = 'gpt-image-2.5-flare-2026-09-08';
// One medium image, bounded prompt and one bounded reference. Reserve conservatively;
// settle the uncached token estimate. Never infer zero cost from a lost response.
export const IMAGE_RESERVATION = 500_000;
export const IMAGE_MAX_BYTES = 3_000_000;
export interface ImageRequest {
  prompt: string;
  size: '1024x1024' | '1536x1024' | '1024x1536';
  image?: string;
}
export function imageBytes(value: string): Buffer {
  if (value.length > 4_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new BadRequestException('Use a PNG image up to 3 MB.');
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.length > IMAGE_MAX_BYTES ||
    bytes.length < 33 ||
    bytes.toString('base64') !== value ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new BadRequestException('Use a valid PNG image up to 3 MB.');
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 1536 ||
    height > 1536 ||
    width * height > 1536 * 1024
  )
    throw new BadRequestException(
      'Use an image up to 1536 × 1024 pixels (portrait is also supported).',
    );
  return bytes;
}
export function validateImageRequest(value: unknown): ImageRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Describe the image to make.');
  const b = value as Record<string, unknown>;
  if (
    Object.keys(b).some((k) => !['prompt', 'size', 'image'].includes(k)) ||
    typeof b.prompt !== 'string' ||
    !b.prompt.trim() ||
    b.prompt.length > 4000 ||
    !['1024x1024', '1536x1024', '1024x1536'].includes(String(b.size))
  )
    throw new BadRequestException(
      'Use an image description up to 4,000 characters and a supported size.',
    );
  if (b.image !== undefined) {
    if (typeof b.image !== 'string')
      throw new BadRequestException('Supply a PNG image to edit.');
    imageBytes(b.image);
  }
  return {
    prompt: b.prompt,
    size: b.size as ImageRequest['size'],
    ...(b.image ? { image: b.image as string } : {}),
  };
}
/** Published Flare rates: $5 text input, $8 image input, $30 image output / MTok.
 * Cache discounts are not exposed reliably in image usage. This is a conservative
 * allowance estimate, never a representation of the provider's invoice. */
export function imageCost(
  usage: unknown,
): { amount: number; input: number; output: number } | null {
  const u = usage as {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  } | null;
  const text = u?.input_tokens_details?.text_tokens;
  const image = u?.input_tokens_details?.image_tokens;
  const output = u?.output_tokens;
  if (
    ![text, image, output, u?.input_tokens].every(
      (n) => Number.isSafeInteger(n) && Number(n) >= 0,
    ) ||
    Number(text) + Number(image) !== u?.input_tokens
  )
    return null;
  const amount = Number(text) * 5 + Number(image) * 8 + Number(output) * 30;
  return Number.isSafeInteger(amount)
    ? { amount, input: Number(text) + Number(image), output: Number(output) }
    : null;
}
