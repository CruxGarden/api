import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { CreateAuthorDto } from './dto/create-author.dto';
import { UpdateAuthorDto } from './dto/update-author.dto';

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

export const AuthorSwagger = {
  Controller: () => ApiTags('Authors'),

  CheckUsername: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Check username availability',
        description:
          'Checks if a username is available for use. Returns true if available or if it belongs to the current user.',
      }),
      ApiQuery({
        name: 'username',
        type: String,
        description: 'Username to check',
        example: 'johndoe',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Username availability status',
        schema: {
          type: 'object',
          properties: {
            available: { type: 'boolean', example: true },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
    ),

  FindAll: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get all authors',
        description: 'Retrieves a paginated list of all authors.',
      }),
      ApiResponse({
        status: 200,
        description: 'List of authors retrieved successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'author_123' },
              username: { type: 'string', example: 'johndoe' },
              display_name: { type: 'string', example: 'John Doe' },
              email: { type: 'string', example: 'john@example.com' },
              bio: { type: 'string', example: 'Software developer and writer' },
              website: { type: 'string', example: 'https://johndoe.com' },
              avatar_url: {
                type: 'string',
                example: 'https://example.com/avatar.jpg',
              },
              created: { type: 'string', format: 'date-time' },
              updated: { type: 'string', format: 'date-time' },
            },
          },
        },
      }),
    ),

  Create: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Create a new author',
        description: 'Creates a new author profile. Requires authentication.',
      }),
      ApiBody({ type: CreateAuthorDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 201,
        description: 'The author has been successfully created.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'author_123' },
            username: { type: 'string', example: 'johndoe' },
            display_name: { type: 'string', example: 'John Doe' },
            email: { type: 'string', example: 'john@example.com' },
            bio: { type: 'string', example: 'Software developer and writer' },
            website: { type: 'string', example: 'https://johndoe.com' },
            avatar_url: {
              type: 'string',
              example: 'https://example.com/avatar.jpg',
            },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
    ),

  FindById: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get an author by ID',
        description:
          'Retrieves a specific author by their unique ID. Use the explicit path /authors/id/:id',
      }),
      ApiParam({
        name: 'id',
        description: 'The unique UUID of the author',
        example: '550e8400-e29b-41d4-a716-446655440000',
      }),
      ApiResponse({
        status: 200,
        description: 'The author data',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'author_123' },
            username: { type: 'string', example: 'johndoe' },
            display_name: { type: 'string', example: 'John Doe' },
            email: { type: 'string', example: 'john@example.com' },
            bio: { type: 'string', example: 'Software developer and writer' },
            website: { type: 'string', example: 'https://johndoe.com' },
            avatar_url: {
              type: 'string',
              example: 'https://example.com/avatar.jpg',
            },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiNotFoundResponse({ description: 'Author not found' }),
    ),

  FindByUsername: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get an author by username',
        description:
          'Retrieves a specific author by their username. Use the explicit path /authors/username/:username',
      }),
      ApiParam({
        name: 'username',
        description: 'The unique username of the author',
        example: 'johndoe',
      }),
      ApiResponse({
        status: 200,
        description: 'The author data',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'author_123' },
            username: { type: 'string', example: 'johndoe' },
            display_name: { type: 'string', example: 'John Doe' },
            email: { type: 'string', example: 'john@example.com' },
            bio: { type: 'string', example: 'Software developer and writer' },
            website: { type: 'string', example: 'https://johndoe.com' },
            avatar_url: {
              type: 'string',
              example: 'https://example.com/avatar.jpg',
            },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiNotFoundResponse({ description: 'Author not found' }),
    ),

  GetByIdentifier: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get an author by key or username',
        description:
          'Retrieves a specific author by their key or username. Prefix identifier with @ to search by username (e.g., @johndoe), otherwise searches by key.',
      }),
      ApiParam({
        name: 'identifier',
        description:
          'Author key (e.g., "gHtdgqnJiE") or @username (e.g., "@johndoe")',
        example: '@johndoe',
      }),
      ApiQuery({
        name: 'embed',
        description:
          'Embed related resources. Use "home" to include the home crux.',
        required: false,
        enum: ['home'],
      }),
      ApiResponse({
        status: 200,
        description: 'The author data',
        schema: {
          oneOf: [
            {
              type: 'object',
              description: 'Author without embedded resources',
              properties: {
                id: { type: 'string', example: 'author_123' },
                key: { type: 'string', example: 'gHtdgqnJiE' },
                username: { type: 'string', example: 'johndoe' },
                displayName: { type: 'string', example: 'John Doe' },
                bio: {
                  type: 'string',
                  example: 'Software developer and writer',
                },
                accountId: {
                  type: 'string',
                  format: 'uuid',
                  example: '550e8400-e29b-41d4-a716-446655440000',
                },
                homeId: {
                  type: 'string',
                  format: 'uuid',
                  example: '550e8400-e29b-41d4-a716-446655440001',
                },
                type: { type: 'string', example: 'individual' },
                kind: { type: 'string', example: 'writer' },
                meta: { type: 'object', example: {} },
                created: { type: 'string', format: 'date-time' },
                updated: { type: 'string', format: 'date-time' },
              },
            },
            {
              type: 'object',
              description: 'Author with embedded home crux (when ?embed=home)',
              properties: {
                id: { type: 'string', example: 'author_123' },
                key: { type: 'string', example: 'gHtdgqnJiE' },
                username: { type: 'string', example: 'johndoe' },
                displayName: { type: 'string', example: 'John Doe' },
                bio: {
                  type: 'string',
                  example: 'Software developer and writer',
                },
                accountId: { type: 'string', example: 'account_456' },
                type: { type: 'string', example: 'individual' },
                kind: { type: 'string', example: 'writer' },
                meta: { type: 'object', example: {} },
                home: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', example: 'crux_789' },
                    key: { type: 'string', example: 'abc123' },
                    title: { type: 'string', example: 'My Home Crux' },
                  },
                },
                created: { type: 'string', format: 'date-time' },
                updated: { type: 'string', format: 'date-time' },
              },
            },
          ],
        },
      }),
      ApiNotFoundResponse({ description: 'Author not found' }),
    ),

  Update: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Update an author',
        description:
          'Updates an existing author profile. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'authorKey',
        description: 'The unique key of the author to update',
        example: 'gHtdgqnJiE',
      }),
      ApiBody({ type: UpdateAuthorDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'The author has been successfully updated.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'author_123' },
            username: { type: 'string', example: 'johndoe' },
            display_name: { type: 'string', example: 'John Updated' },
            email: { type: 'string', example: 'john.updated@example.com' },
            bio: { type: 'string', example: 'Updated bio information' },
            website: { type: 'string', example: 'https://johnupdated.com' },
            avatar_url: {
              type: 'string',
              example: 'https://example.com/new-avatar.jpg',
            },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Author not found' }),
    ),

  Delete: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Delete an author',
        description:
          'Deletes an existing author profile. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'authorKey',
        description: 'The unique key of the author to delete',
        example: 'gHtdgqnJiE',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'The author has been successfully deleted.',
        schema: {
          type: 'object',
          properties: {
            message: { type: 'string', example: 'Author deleted successfully' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Author not found' }),
    ),
};
