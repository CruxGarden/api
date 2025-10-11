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
import { CreateHomeDto } from './dto/create-home.dto';
import { UpdateHomeDto } from './dto/update-home.dto';

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

export const HomeSwagger = {
  Controller: () => ApiTags('Homes'),

  Create: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Create a new home',
        description:
          'Creates a new home with the provided data. Requires admin authentication.',
      }),
      ApiBody({ type: CreateHomeDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 201,
        description: 'The home has been successfully created.',
        schema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440000',
            },
            key: { type: 'string', example: 'my-garden' },
            name: { type: 'string', example: 'My Garden' },
            description: {
              type: 'string',
              example: 'A personal knowledge garden',
            },
            primary: { type: 'boolean', example: true },
            type: { type: 'string', example: 'personal' },
            kind: { type: 'string', example: 'garden' },
            meta: {
              type: 'object',
              example: { color: 'blue', icon: 'tree' },
            },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Admin access required' }),
      ApiBadRequestResponse({ description: 'Invalid input data' }),
    ),

  GetAll: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get all homes',
        description: 'Retrieves a paginated list of all homes.',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'List of homes retrieved successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              key: { type: 'string', example: 'my-garden' },
              name: { type: 'string', example: 'My Garden' },
              description: { type: 'string' },
              primary: { type: 'boolean', example: true },
              type: { type: 'string', example: 'personal' },
              kind: { type: 'string', example: 'garden' },
              meta: { type: 'object' },
              created: { type: 'string', format: 'date-time' },
              updated: { type: 'string', format: 'date-time' },
            },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
    ),

  GetByKey: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get a home by key',
        description: 'Retrieves a specific home by its unique key.',
      }),
      ApiParam({
        name: 'homeKey',
        description: 'The unique key of the home',
        example: 'my-garden',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'The home data',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            key: { type: 'string', example: 'my-garden' },
            name: { type: 'string', example: 'My Garden' },
            description: { type: 'string' },
            primary: { type: 'boolean', example: true },
            type: { type: 'string', example: 'personal' },
            kind: { type: 'string', example: 'garden' },
            meta: { type: 'object' },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiNotFoundResponse({ description: 'Home not found' }),
    ),

  Update: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Update a home',
        description:
          'Updates an existing home with the provided data. Requires admin authentication.',
      }),
      ApiParam({
        name: 'homeKey',
        description: 'The unique key of the home to update',
        example: 'my-garden',
      }),
      ApiBody({ type: UpdateHomeDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'The home has been successfully updated.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            key: { type: 'string', example: 'my-garden' },
            name: { type: 'string', example: 'Updated Garden Name' },
            description: { type: 'string' },
            primary: { type: 'boolean', example: true },
            type: { type: 'string', example: 'personal' },
            kind: { type: 'string', example: 'garden' },
            meta: { type: 'object' },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Admin access required' }),
      ApiNotFoundResponse({ description: 'Home not found' }),
      ApiBadRequestResponse({ description: 'Invalid input data' }),
    ),

  Delete: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Delete a home',
        description: 'Deletes an existing home. Requires admin authentication.',
      }),
      ApiParam({
        name: 'homeKey',
        description: 'The unique key of the home to delete',
        example: 'my-garden',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 204,
        description: 'The home has been successfully deleted.',
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Admin access required' }),
      ApiNotFoundResponse({ description: 'Home not found' }),
    ),
};
