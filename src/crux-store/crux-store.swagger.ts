import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';
import { STORE_MODES } from './entities/crux-store.entity';

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

const cruxIdParam = ApiParam({
  name: 'cruxId',
  description: 'The published crux whose store this is',
});
const keyParam = ApiParam({ name: 'key', description: 'Store key' });

const MODE_DOC =
  'A key has one mode, fixed by its first write. ' +
  '`public` — open: anyone reads and writes one shared value. ' +
  '`protected` — authenticated, per user: signed-in account required; one ' +
  'private slot per account. ' +
  '`common` — authenticated, shared: one value per key belonging to the crux; ' +
  'signed-in account required to write, increment or delete; anyone reads.';

const VALUE_SHAPE = {
  type: 'object',
  properties: {
    value: { nullable: true },
    mode: { type: 'string', enum: [...STORE_MODES] },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['value'],
};

export const StoreSwagger = {
  Controller: () => ApiTags('Store'),

  Get: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Read a store key',
        description:
          'Public and common keys need no token and return the shared value. ' +
          'Protected keys return the caller’s own slot (token needed; ' +
          'otherwise `{ value: null }`). ' +
          MODE_DOC,
      }),
      cruxIdParam,
      keyParam,
      ApiResponse({
        status: 200,
        description:
          '`{ value, mode, updatedAt }`, or `{ value: null }` when unset or ' +
          'not readable by the caller.',
        schema: VALUE_SHAPE,
      }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  Set: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Write a store key',
        description:
          'Public keys need no token. Protected keys need a token and write ' +
          'the caller’s own slot. Common keys need a token and write the one ' +
          'shared value. ' +
          MODE_DOC,
      }),
      cruxIdParam,
      keyParam,
      ApiResponse({
        status: 200,
        description: 'The stored value',
        schema: { type: 'object', properties: { value: {} } },
      }),
      ApiUnauthorizedResponse({
        description: 'Protected or common key written without a token',
      }),
      ApiConflictResponse({
        description: 'The key already has a different mode',
      }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  Increment: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Atomically increment a store key',
        description:
          'Public and common keys increment the shared value (common needs a ' +
          'token). Protected keys increment the caller’s own slot. A missing ' +
          'value is created at `by`. A key that does not exist is created in ' +
          '`mode`, else protected when signed in and public otherwise.',
      }),
      cruxIdParam,
      keyParam,
      ApiResponse({
        status: 201,
        description: 'The new value',
        schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
        },
      }),
      ApiUnauthorizedResponse({
        description: 'Protected or common key incremented without a token',
      }),
      ApiConflictResponse({
        description: 'The key already has a different mode',
      }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  Delete: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Delete a store key or the caller’s slot',
        description:
          'The crux author deletes the whole key (every slot). Anyone else ' +
          'deletes the shared value of a public key, the shared value of a ' +
          'common key (token required), or their own slot on a protected key ' +
          '(token required).',
      }),
      cruxIdParam,
      keyParam,
      ApiResponse({ status: 204, description: 'Deleted' }),
      ApiUnauthorizedResponse({
        description: 'Protected or common key deleted without a token',
      }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  List: () =>
    combineDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'List every store row of a crux (author only)',
        description: `Every row, all slots included. Modes: ${STORE_MODES.join(', ')}.`,
      }),
      cruxIdParam,
      ApiResponse({ status: 200, description: 'Store rows' }),
      ApiUnauthorizedResponse({ description: 'Token required' }),
      ApiForbiddenResponse({ description: 'Not the crux author' }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  ClearAll: () =>
    combineDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Clear every store key of a crux (author only)',
      }),
      cruxIdParam,
      ApiResponse({ status: 204, description: 'Cleared' }),
      ApiUnauthorizedResponse({ description: 'Token required' }),
      ApiForbiddenResponse({ description: 'Not the crux author' }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),
};
