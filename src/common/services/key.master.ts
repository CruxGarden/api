import { Injectable } from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import ShortUniqueId from 'short-unique-id';

// 64 characters (A-Z, a-z, 0-9, -, _)
// Supports URL-safe characters for direct use in paths
const UID_DICTIONARY =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('');

// 11 characters with 64-char alphabet = 64^11 = ~73 quintillion unique IDs
const DEFAULT_KEY_LENGTH = 11;

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
