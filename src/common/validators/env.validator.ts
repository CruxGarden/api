import { readFileSync } from 'fs';
import { join } from 'path';

export class EnvValidator {
  static validate(): void {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
    );

    const required: string[] = pkg.env?.required || [];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      console.error('Missing required environment variables:');
      missing.forEach((key) => console.error(`  - ${key}`));
      throw new Error(
        `Missing ${missing.length} required environment variable(s)`,
      );
    }
  }
}
