import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

/**
 * Secrets at rest (CRUX-FUNCTIONS-PLAN F1): AES-256-GCM under the server's
 * key. FUNCTIONS_SECRET_KEY (32 bytes, hex or base64) is the key; without it
 * the key is derived from JWT_SECRET, which keeps a single-machine garden
 * working with one secret to manage. Rotating the key re-encrypts nothing —
 * secrets set before a rotation stop decrypting and must be set again.
 */
let cached: Buffer | null = null;
export function secretsKey(): Buffer {
  if (cached) return cached;
  const raw = process.env.FUNCTIONS_SECRET_KEY;
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
    if (buf.length !== 32)
      throw new Error('FUNCTIONS_SECRET_KEY must be 32 bytes (hex or base64)');
    cached = buf;
    return buf;
  }
  const seed = process.env.JWT_SECRET;
  if (!seed) throw new Error('FUNCTIONS_SECRET_KEY or JWT_SECRET is required');
  cached = scryptSync(seed, 'crux-garden:function-secrets', 32);
  return cached;
}

export function encryptSecret(value: string): {
  ciphertext: string;
  iv: string;
  tag: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretsKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(row: {
  ciphertext: string;
  iv: string;
  tag: string;
}): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    secretsKey(),
    Buffer.from(row.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
