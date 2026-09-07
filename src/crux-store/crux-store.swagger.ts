import {
  ApiBadRequestResponse,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiTooManyRequestsResponse,
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

const writeRateLimited = ApiTooManyRequestsResponse({
  description:
    'This account wrote more than STORE_WRITES_PER_MINUTE_PER_ACCOUNT ' +
    '(default 60) times in the last minute',
});

const MODE_DOC =
  'A key has one mode, fixed by its first write. Every write (set, increment, ' +
  'delete) needs a signed-in account. ' +
  '`public` — open: one shared value belonging to the crux that anyone reads. ' +
  '`protected` — per user: one private slot per account, read and written ' +
  'only by its owner.';

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
          'Public keys need no token and return the shared value. ' +
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
          'Token required. Public keys write the one shared value; protected ' +
          'keys write the caller’s own slot. ' +
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
        description: 'Written without a token',
      }),
      writeRateLimited,
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
          'Token required. Public keys increment the shared value; protected ' +
          'keys increment the caller’s own slot. A missing value is created ' +
          'at `by`. A key that does not exist is created in `mode`, else ' +
          'protected.',
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
        description: 'Incremented without a token',
      }),
      writeRateLimited,
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
          'Token required. The crux author deletes the whole key (every ' +
          'slot). Anyone else deletes the shared value of a public key or ' +
          'their own slot on a protected key.',
      }),
      cruxIdParam,
      keyParam,
      ApiResponse({ status: 204, description: 'Deleted' }),
      ApiUnauthorizedResponse({
        description: 'Deleted without a token',
      }),
      writeRateLimited,
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

  Export: () =>
    combineDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary:
          'Export the whole store of a crux as one JSON document (author only)',
        description:
          'Shape: { format: "crux-store", version: 1, cruxId, exportedAt, public: { key: value }, protected: { visitorId: { key: value } } }. The same document is accepted by import — on this crux, another crux, or the workspace\'s local store.',
      }),
      cruxIdParam,
      ApiResponse({ status: 200, description: 'The store document' }),
      ApiUnauthorizedResponse({ description: 'Token required' }),
      ApiForbiddenResponse({ description: 'Not the crux author' }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  Import: () =>
    combineDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Import a store document into a crux (author only)',
        description:
          'Body is a document from export. Keys are upserted over what is there; `?mode=replace` empties the store first. Per-visitor values whose visitor is not an account are skipped and counted.',
      }),
      cruxIdParam,
      ApiResponse({
        status: 200,
        description: '{ imported, skipped }',
      }),
      ApiBadRequestResponse({ description: 'Not a Crux Store export' }),
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
