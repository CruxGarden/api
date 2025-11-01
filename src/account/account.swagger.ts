import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { UpdateAccountDto } from './dto/update-account.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';

// Helper function to combine multiple decorators
const combineDecorators = (...decorators: any[]) => {
  return (target: any, propertyKey?: string | symbol, descriptor?: any) => {
    decorators.forEach((decorator) => {
      if (typeof decorator === 'function') {
        decorator(target, propertyKey, descriptor);
      }
    });
  };
};

export const AccountSwagger = {
  Controller: () => ApiTags('Account Management'),

  CheckEmail: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Check email availability',
        description:
          'Checks if an email address is available for use. Returns true if available or if it belongs to the current user.',
      }),
      ApiQuery({
        name: 'email',
        type: String,
        description: 'Email address to check',
        example: 'user@example.com',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Email availability status',
        schema: {
          type: 'object',
          properties: {
            available: { type: 'boolean', example: true },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiBadRequestResponse({ description: 'Invalid email format' }),
    ),

  GetAccount: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get account',
        description: "Retrieves the authenticated user's account.",
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Account retrieved successfully',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', example: 'user@example.com' },
            role: { type: 'string', enum: ['admin', 'author', 'keeper'] },
            homeId: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440001',
            },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiNotFoundResponse({ description: 'Account not found' }),
    ),

  UpdateAccount: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Update account (partial)',
        description:
          "Partially updates the authenticated user's account information. Only provided fields will be updated.",
      }),
      ApiBody({ type: UpdateAccountDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Account updated successfully',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', example: 'user@example.com' },
            role: { type: 'string', enum: ['admin', 'author', 'keeper'] },
            homeId: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440001',
            },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiNotFoundResponse({ description: 'Account not found' }),
      ApiForbiddenResponse({
        description: "Cannot update another user's account",
      }),
      ApiConflictResponse({ description: 'Email already exists' }),
      ApiBadRequestResponse({ description: 'Invalid input data' }),
    ),

  DeleteAccount: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Delete account',
        description:
          "Permanently deletes the authenticated user's account. Requires confirmation.",
      }),
      ApiBody({ type: DeleteAccountDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 204,
        description: 'Account deleted successfully',
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiNotFoundResponse({ description: 'Account not found' }),
      ApiForbiddenResponse({
        description: "Cannot delete another user's account",
      }),
      ApiBadRequestResponse({
        description: 'Confirmation text does not match',
      }),
    ),
};
