import { ServiceUnavailableException } from '@nestjs/common';
import type { RepositoryResponse } from '../common/types/interfaces';

export function operationResult<T>(result: RepositoryResponse<T>): T {
  if (result.error)
    throw new ServiceUnavailableException(
      'Billing operational state is unavailable',
    );
  return result.data;
}
/** Safe codes rather than provider responses, payloads or credential-bearing messages. */
export function billingFailureCode(error: unknown): string {
  if (
    error instanceof Error &&
    [
      'BadRequestException',
      'NotFoundException',
      'ServiceUnavailableException',
      'InternalServerErrorException',
    ].includes(error.name)
  )
    return error.name;
  return 'provider_or_delivery_failed';
}
