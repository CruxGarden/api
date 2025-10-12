import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { CreateDimensionDto } from './dto/create-dimension.dto';
import { UpdateDimensionDto } from './dto/update-dimension.dto';

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

export const DimensionSwagger = {
  Controller: () => ApiTags('Dimensions'),

  GetByKey: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get a dimension by key',
        description: 'Retrieves a single dimension by its unique key.',
      }),
      ApiParam({
        name: 'dimensionKey',
        description: 'The unique key of the dimension',
        example: 'TKSoWfISLG_',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Dimension retrieved successfully.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'dim_123' },
            key: { type: 'string', example: 'TKSoWfISLG_' },
            sourceId: { type: 'string', example: 'crux_123' },
            targetId: { type: 'string', example: 'crux_456' },
            type: { type: 'string', example: 'gate' },
            weight: { type: 'number', example: 1 },
            note: { type: 'string', example: 'Prerequisite concept' },
            authorId: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440000',
            },
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
      ApiNotFoundResponse({ description: 'Dimension not found' }),
    ),

  GetDimensions: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get dimensions for a crux',
        description:
          'Retrieves all dimensional relationships for a specific crux, optionally filtered by type.',
      }),
      ApiParam({
        name: 'key',
        description: 'The unique key of the crux',
        example: 'abc123',
      }),
      ApiQuery({
        name: 'type',
        description: 'Filter by dimension type',
        required: false,
        enum: ['gate', 'garden', 'growth', 'graft'],
      }),
      ApiResponse({
        status: 200,
        description: 'Dimensions retrieved successfully',
        schema: {
          type: 'object',
          properties: {
            dimensions: {
              type: 'object',
              properties: {
                gate: { type: 'array', items: { type: 'object' } },
                garden: { type: 'array', items: { type: 'object' } },
                growth: { type: 'array', items: { type: 'object' } },
                graft: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  CreateDimensions: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Add dimensions to a crux',
        description:
          'Creates new dimensional relationships between a crux and target cruxes.',
      }),
      ApiParam({
        name: 'key',
        description: 'The unique key of the source crux',
        example: 'abc123',
      }),
      ApiParam({
        name: 'type',
        description: 'The type of dimensional relationship',
        enum: ['gate', 'garden', 'growth', 'graft'],
      }),
      ApiBody({ type: CreateDimensionDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 201,
        description: 'Dimensions added successfully',
        schema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              example: 'Dimensions added successfully',
            },
            count: { type: 'number', example: 3 },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Source crux not found' }),
    ),

  RemoveDimensions: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Remove dimensions from a crux',
        description:
          'Removes specific dimensional relationships of a given type.',
      }),
      ApiParam({
        name: 'key',
        description: 'The unique key of the source crux',
        example: 'abc123',
      }),
      ApiParam({
        name: 'type',
        description: 'The type of dimensional relationship to remove',
        enum: ['gate', 'garden', 'growth', 'graft'],
      }),
      ApiBody({
        description: 'Array of target crux IDs to remove',
        schema: {
          type: 'array',
          items: { type: 'string' },
          example: ['crux_123', 'crux_456'],
        },
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Dimensions removed successfully',
        schema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              example: 'Dimensions removed successfully',
            },
            count: { type: 'number', example: 2 },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Source crux not found' }),
    ),

  UpdateDimension: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Update a dimension',
        description: 'Updates an existing dimensional relationship.',
      }),
      ApiParam({
        name: 'dimensionKey',
        description: 'The unique key of the dimension to update',
        example: 'TKSoWfISLG_',
      }),
      ApiBody({ type: UpdateDimensionDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Dimension updated successfully',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'dim_123' },
            key: { type: 'string', example: 'TKSoWfISLG_' },
            sourceId: { type: 'string', example: 'crux_123' },
            targetId: { type: 'string', example: 'crux_456' },
            type: { type: 'string', example: 'gate' },
            weight: { type: 'number', example: 2 },
            note: { type: 'string', example: 'Updated note' },
            authorId: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440000',
            },
            homeId: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440001',
            },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Dimension not found' }),
    ),

  DeleteDimension: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Delete a dimension',
        description: 'Soft deletes a dimensional relationship.',
      }),
      ApiParam({
        name: 'dimensionKey',
        description: 'The unique key of the dimension to delete',
        example: 'TKSoWfISLG_',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 204,
        description: 'Dimension deleted successfully',
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Dimension not found' }),
    ),
};
