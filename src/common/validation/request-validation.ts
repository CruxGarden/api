import { ValidationPipe } from '@nestjs/common';

/** One request contract for the server and HTTP tests. DTO-declared meta stays opaque. */
export function createRequestValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    forbidUnknownValues: false,
  });
}
