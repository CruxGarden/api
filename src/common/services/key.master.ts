import { Injectable } from '@nestjs/common';
import { randomUUID as uuidv4, randomBytes } from 'crypto';

@Injectable()
export class KeyMaster {
  generateId(): string {
    return uuidv4();
  }

  generateToken(length: number = 32): string {
    return randomBytes(length).toString('base64url').slice(0, length);
  }
}
