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
import { CreateCruxDto } from './dto/create-crux.dto';
import { UpdateCruxDto } from './dto/update-crux.dto';

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

export const CruxSwagger = {
  Controller: () => ApiTags('Cruxes'),

  FindAll: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get all cruxes',
        description:
          'Retrieves a paginated list of all cruxes with their authors.',
      }),
      ApiResponse({
        status: 200,
        description: 'List of cruxes retrieved successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'crux_123' },
              key: { type: 'string', example: 'abc123' },
              slug: { type: 'string', example: 'my-awesome-crux' },
              title: { type: 'string', example: 'My Awesome Crux' },
              data: {
                type: 'string',
                example: 'This is the content of my crux',
              },
              type: { type: 'string', example: 'text' },
              status: { type: 'string', example: 'living' },
              visibility: { type: 'string', example: 'public' },
              author_username: { type: 'string', example: 'johndoe' },
              author_display_name: { type: 'string', example: 'John Doe' },
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
        summary: 'Create a new crux',
        description:
          'Creates a new crux with the provided data. Requires authentication.',
      }),
      ApiBody({ type: CreateCruxDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 201,
        description: 'The crux has been successfully created.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'crux_123' },
            key: { type: 'string', example: 'abc123' },
            slug: { type: 'string', example: 'my-awesome-crux' },
            title: { type: 'string', example: 'My Awesome Crux' },
            data: { type: 'string', example: 'This is the content of my crux' },
            type: { type: 'string', example: 'text' },
            status: { type: 'string', example: 'living' },
            visibility: { type: 'string', example: 'unlisted' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
    ),

  GetByKey: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get a crux by key',
        description: 'Retrieves a specific crux by its unique key.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the crux',
        example: 'abc123',
      }),
      ApiResponse({
        status: 200,
        description: 'The crux data',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'crux_123' },
            key: { type: 'string', example: 'abc123' },
            slug: { type: 'string', example: 'my-awesome-crux' },
            title: { type: 'string', example: 'My Awesome Crux' },
            data: { type: 'string', example: 'This is the content of my crux' },
            type: { type: 'string', example: 'text' },
            status: { type: 'string', example: 'living' },
            visibility: { type: 'string', example: 'unlisted' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  Update: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Update a crux',
        description:
          'Updates an existing crux with the provided data. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the crux to update',
        example: 'abc123',
      }),
      ApiBody({ type: UpdateCruxDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'The crux has been successfully updated.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'crux_123' },
            key: { type: 'string', example: 'abc123' },
            slug: { type: 'string', example: 'my-awesome-crux' },
            title: { type: 'string', example: 'My Updated Crux' },
            data: { type: 'string', example: 'This is the updated content' },
            type: { type: 'string', example: 'text' },
            status: { type: 'string', example: 'living' },
            visibility: { type: 'string', example: 'public' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  Delete: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Delete a crux',
        description:
          'Deletes an existing crux. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the crux to delete',
        example: 'abc123',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 204,
        description: 'The crux has been successfully deleted.',
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  GetTags: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get all tags for a crux',
        description: 'Retrieves all tags associated with a specific crux.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the crux',
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
              label: { type: 'string', example: 'web-development' },
              created: { type: 'string', format: 'date-time' },
              updated: { type: 'string', format: 'date-time' },
            },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  SyncTags: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Sync tags for a crux',
        description:
          'Replaces all tags for a crux with the provided list. Tags must be in kebab-case format.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the crux',
        example: 'abc123',
      }),
      ApiBody({
        schema: {
          type: 'object',
          properties: {
            labels: {
              type: 'array',
              items: { type: 'string' },
              example: ['web-development', 'javascript', 'tutorial'],
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
              label: { type: 'string', example: 'web-development' },
              resourceType: { type: 'string', example: 'crux' },
              resourceId: { type: 'string', format: 'uuid' },
              authorId: { type: 'string', format: 'uuid' },
              created: { type: 'string', format: 'date-time' },
              updated: { type: 'string', format: 'date-time' },
            },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({
        description: 'No permission to manage tags for this crux',
      }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
      ApiBadRequestResponse({
        description: 'Invalid tag label format (must be kebab-case)',
      }),
    ),

  GetDimensions: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get dimensions for a crux',
        description:
          'Retrieves all dimensional relationships for a crux, optionally filtered by type.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the crux',
        example: 'abc123',
      }),
      ApiResponse({
        status: 200,
        description: 'Dimensions retrieved successfully',
        schema: {
          type: 'object',
          properties: {
            gate: { type: 'array', items: { type: 'object' } },
            garden: { type: 'array', items: { type: 'object' } },
            growth: { type: 'array', items: { type: 'object' } },
            graft: { type: 'array', items: { type: 'object' } },
          },
        },
      }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  CreateDimension: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Create a new dimension from this crux',
        description:
          'Creates a new dimensional relationship from this crux to another crux.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the source crux',
        example: 'abc123',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 201,
        description: 'Dimension created successfully',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'dim_123' },
            sourceId: { type: 'string', example: 'crux_123' },
            targetId: { type: 'string', example: 'crux_456' },
            type: { type: 'string', example: 'gate' },
            weight: { type: 'number', example: 1 },
            note: { type: 'string', example: 'Connection note' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
      ApiBadRequestResponse({
        description: 'Invalid dimension type or target IDs',
      }),
    ),

  UpdateDimension: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Update a dimension',
        description:
          'Updates an existing dimensional relationship. Requires authentication and ownership of the source crux.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the source crux',
        example: 'abc123',
      }),
      ApiParam({
        name: 'dimensionId',
        description: 'The unique ID of the dimension to update',
        example: 'dim_123',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Dimension updated successfully',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'dim_123' },
            sourceId: { type: 'string', example: 'crux_123' },
            targetId: { type: 'string', example: 'crux_456' },
            type: { type: 'string', example: 'gate' },
            weight: { type: 'number', example: 2 },
            note: { type: 'string', example: 'Updated note' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Dimension or crux not found' }),
    ),
};
