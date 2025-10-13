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
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { CreatePathDto } from './dto/create-path.dto';
import { UpdatePathDto } from './dto/update-path.dto';
import { SyncMarkersDto } from './dto/sync-markers.dto';

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

export const PathSwagger = {
  Controller: () => ApiTags('Paths'),

  FindAll: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get all paths',
        description:
          'Retrieves a paginated list of all paths with their metadata.',
      }),
      ApiResponse({
        status: 200,
        description: 'List of paths retrieved successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              key: { type: 'string', example: 'abc123' },
              slug: { type: 'string', example: 'my-awesome-path' },
              title: { type: 'string', example: 'My Awesome Path' },
              description: {
                type: 'string',
                example: 'A journey through code',
              },
              type: { type: 'string', example: 'living' },
              visibility: { type: 'string', example: 'public' },
              kind: { type: 'string', example: 'guide' },
              entry: { type: 'string', format: 'uuid' },
              authorId: { type: 'string', format: 'uuid' },
              homeId: { type: 'string', format: 'uuid' },
              themeId: { type: 'string', format: 'uuid' },
              meta: { type: 'object', example: {} },
              created: { type: 'string', format: 'date-time' },
              updated: { type: 'string', format: 'date-time' },
            },
          },
        },
      }),
    ),

  GetByKey: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get a path by key',
        description: 'Retrieves a specific path by its unique key.',
      }),
      ApiParam({
        name: 'pathKey',
        description: 'The unique key of the path',
        example: 'abc123',
      }),
      ApiResponse({
        status: 200,
        description: 'The path data',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            key: { type: 'string', example: 'abc123' },
            slug: { type: 'string', example: 'my-awesome-path' },
            title: { type: 'string', example: 'My Awesome Path' },
            description: {
              type: 'string',
              example: 'A journey through code',
            },
            type: { type: 'string', example: 'living' },
            visibility: { type: 'string', example: 'public' },
            kind: { type: 'string', example: 'guide' },
            entry: { type: 'string', format: 'uuid' },
            authorId: { type: 'string', format: 'uuid' },
            homeId: { type: 'string', format: 'uuid' },
            themeId: { type: 'string', format: 'uuid' },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiNotFoundResponse({ description: 'Path not found' }),
    ),

  Create: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Create a new path',
        description:
          'Creates a new path with the provided data. Requires authentication.',
      }),
      ApiBody({ type: CreatePathDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 201,
        description: 'The path has been successfully created.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            key: { type: 'string', example: 'abc123' },
            slug: { type: 'string', example: 'my-awesome-path' },
            title: { type: 'string', example: 'My Awesome Path' },
            description: {
              type: 'string',
              example: 'A journey through code',
            },
            type: { type: 'string', example: 'living' },
            visibility: { type: 'string', example: 'unlisted' },
            kind: { type: 'string', example: 'guide' },
            entry: { type: 'string', format: 'uuid' },
            authorId: { type: 'string', format: 'uuid' },
            homeId: { type: 'string', format: 'uuid' },
            themeId: { type: 'string', format: 'uuid' },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
    ),

  Update: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Update a path',
        description:
          'Updates an existing path with the provided data. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'pathKey',
        description: 'The unique key of the path to update',
        example: 'abc123',
      }),
      ApiBody({ type: UpdatePathDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'The path has been successfully updated.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            key: { type: 'string', example: 'abc123' },
            slug: { type: 'string', example: 'my-updated-path' },
            title: { type: 'string', example: 'My Updated Path' },
            description: { type: 'string', example: 'Updated description' },
            type: { type: 'string', example: 'frozen' },
            visibility: { type: 'string', example: 'public' },
            kind: { type: 'string', example: 'wander' },
            entry: { type: 'string', format: 'uuid' },
            authorId: { type: 'string', format: 'uuid' },
            homeId: { type: 'string', format: 'uuid' },
            themeId: { type: 'string', format: 'uuid' },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Path not found' }),
    ),

  Delete: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Delete a path',
        description:
          'Deletes an existing path. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'pathKey',
        description: 'The unique key of the path to delete',
        example: 'abc123',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 204,
        description: 'The path has been successfully deleted.',
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Path not found' }),
    ),

  GetTags: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get all tags for a path',
        description: 'Retrieves all tags associated with a specific path.',
      }),
      ApiParam({
        name: 'pathKey',
        description: 'The unique key of the path',
        example: 'abc123',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Tags retrieved successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              key: { type: 'string', example: 'TKSoWfISLG_' },
              label: { type: 'string', example: 'tutorial' },
              resourceType: { type: 'string', example: 'path' },
              resourceId: { type: 'string', format: 'uuid' },
              authorId: { type: 'string', format: 'uuid' },
              homeId: { type: 'string', format: 'uuid' },
              created: { type: 'string', format: 'date-time' },
              updated: { type: 'string', format: 'date-time' },
            },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiNotFoundResponse({ description: 'Path not found' }),
    ),

  SyncTags: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Sync tags for a path',
        description:
          'Replaces all tags for a path with the provided list. Tags must be in kebab-case format.',
      }),
      ApiParam({
        name: 'pathKey',
        description: 'The unique key of the path',
        example: 'abc123',
      }),
      ApiBody({
        schema: {
          type: 'object',
          properties: {
            labels: {
              type: 'array',
              items: { type: 'string' },
              example: ['tutorial', 'learning-path', 'beginner'],
            },
          },
        },
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Tags synced successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              key: { type: 'string', example: 'TKSoWfISLG_' },
              label: { type: 'string', example: 'tutorial' },
              resourceType: { type: 'string', example: 'path' },
              resourceId: { type: 'string', format: 'uuid' },
              authorId: { type: 'string', format: 'uuid' },
              homeId: { type: 'string', format: 'uuid' },
              created: { type: 'string', format: 'date-time' },
              updated: { type: 'string', format: 'date-time' },
            },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({
        description: 'No permission to manage tags for this path',
      }),
      ApiNotFoundResponse({ description: 'Path not found' }),
      ApiBadRequestResponse({
        description: 'Invalid tag label format (must be kebab-case)',
      }),
    ),

  GetMarkers: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get all markers for a path',
        description:
          'Retrieves all markers (crux references) for a specific path in order.',
      }),
      ApiParam({
        name: 'pathKey',
        description: 'The unique key of the path',
        example: 'abc123',
      }),
      ApiResponse({
        status: 200,
        description: 'Markers retrieved successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              key: { type: 'string', example: 'TKSoWfISLG_' },
              pathId: { type: 'string', format: 'uuid' },
              cruxId: { type: 'string', format: 'uuid' },
              order: { type: 'number', example: 0 },
              note: { type: 'string', example: 'Start here' },
              authorId: { type: 'string', format: 'uuid' },
              homeId: { type: 'string', format: 'uuid' },
              created: { type: 'string', format: 'date-time' },
              updated: { type: 'string', format: 'date-time' },
            },
          },
        },
      }),
      ApiNotFoundResponse({ description: 'Path not found' }),
    ),

  SyncMarkers: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Sync markers for a path',
        description:
          'Replaces all markers for a path with the provided list. Each marker references a crux by key.',
      }),
      ApiParam({
        name: 'pathKey',
        description: 'The unique key of the path',
        example: 'abc123',
      }),
      ApiBody({ type: SyncMarkersDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Markers synced successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              key: { type: 'string', example: 'TKSoWfISLG_' },
              pathId: { type: 'string', format: 'uuid' },
              cruxId: { type: 'string', format: 'uuid' },
              order: { type: 'number', example: 0 },
              note: { type: 'string', example: 'Start here' },
              authorId: { type: 'string', format: 'uuid' },
              homeId: { type: 'string', format: 'uuid' },
              created: { type: 'string', format: 'date-time' },
              updated: { type: 'string', format: 'date-time' },
            },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({
        description: 'No permission to manage markers for this path',
      }),
      ApiNotFoundResponse({ description: 'Path or referenced crux not found' }),
      ApiBadRequestResponse({
        description: 'Invalid marker data',
      }),
    ),
};
