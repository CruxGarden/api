import { Injectable } from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import ShortUniqueId from 'short-unique-id';

// 64 characters (A-Z, a-z, 0-9, -, _)
// Supports URL-safe characters for direct use in paths
const UID_DICTIONARY =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('');

// 16 characters with 64-char alphabet = 64^16 = ~79 octillion unique IDs
// 50% collision probability at ~280 trillion IDs
const DEFAULT_KEY_LENGTH = 16;

@Injectable()
export class KeyMaster {
  private readonly keyGenerator: ShortUniqueId;

  constructor() {
    this.keyGenerator = new ShortUniqueId({
      length: DEFAULT_KEY_LENGTH,
      dictionary: UID_DICTIONARY,
    });
  }

  generateId(): string {
    return uuidv4();
  }

  generateKey(length = DEFAULT_KEY_LENGTH): string {
    return this.keyGenerator.rnd(length);
  }
}
