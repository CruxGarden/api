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
  ApiQuery,
} from '@nestjs/swagger';
import { UpdateTagDto } from './dto/update-tag.dto';

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

export const TagSwagger = {
  Controller: () => ApiTags('Tags'),

  FindAll: () =>
    combineDecorators(
      ApiOperation({
        summary: 'List all tags',
        description:
          'Retrieves all tags with optional filtering by resource type, search term, and sorting. Results are paginated - use Link and Pagination response headers for navigation.',
      }),
      ApiQuery({
        name: 'resourceType',
        description: 'Filter tags by resource type (crux, path, or theme)',
        required: false,
        enum: ['crux', 'path', 'theme'],
        example: 'crux',
      }),
      ApiQuery({
        name: 'search',
        description:
          'Search term to filter tags by label (case-insensitive partial match)',
        required: false,
        example: 'frontend',
      }),
      ApiQuery({
        name: 'sort',
        description:
          'Sort order: "alpha" for alphabetical, "count" for most used (default: count)',
        required: false,
        enum: ['alpha', 'count'],
        example: 'count',
      }),
      ApiQuery({
        name: 'label',
        description: 'Filter by exact label match (case-sensitive)',
        required: false,
        example: 'javascript',
      }),
      ApiQuery({
        name: 'page',
        description: 'Page number for pagination (default: 1)',
        required: false,
        example: 1,
      }),
      ApiQuery({
        name: 'perPage',
        description: 'Number of results per page (default: 25)',
        required: false,
        example: 25,
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description:
          'Tags retrieved successfully. Check Link header for pagination links and Pagination header for metadata.',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'tag_123' },
              key: { type: 'string', example: 'abcd1234' },
              resourceType: {
                type: 'string',
                enum: ['crux', 'path', 'theme'],
                example: 'crux',
              },
              resourceId: { type: 'string', example: 'crux_456' },
              label: { type: 'string', example: 'frontend-development' },
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
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
    ),

  GetByKey: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get a tag by key',
        description: 'Retrieves a single tag by its unique key.',
      }),
      ApiParam({
        name: 'tagKey',
        description: 'The unique key of the tag',
        example: 'abcd1234',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Tag retrieved successfully.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'tag_123' },
            key: { type: 'string', example: 'abcd1234' },
            resourceType: { type: 'string', example: 'crux' },
            resourceId: { type: 'string', example: 'crux_456' },
            label: { type: 'string', example: 'frontend-development' },
            authorId: { type: 'string', example: 'author_789' },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiNotFoundResponse({ description: 'Tag not found' }),
    ),

  UpdateTag: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Update a tag',
        description:
          'Updates the label of an existing tag by its key. This is an admin-only operation and affects ALL resources using this tag.',
      }),
      ApiParam({
        name: 'tagKey',
        description: 'The unique key of the tag to update',
        example: 'abcd1234',
      }),
      ApiBody({ type: UpdateTagDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Tag updated successfully.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'tag_123' },
            key: { type: 'string', example: 'abcd1234' },
            resourceType: {
              type: 'string',
              enum: ['crux', 'path', 'theme'],
              example: 'crux',
            },
            resourceId: { type: 'string', example: 'crux_456' },
            label: {
              type: 'string',
              example: 'frontend-development',
              description: 'Updated label (lowercase kebab-case)',
            },
            authorId: { type: 'string', example: 'author_789' },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Admin permissions required' }),
      ApiNotFoundResponse({ description: 'Tag not found' }),
      ApiBadRequestResponse({
        description:
          'Invalid tag label format (must be lowercase kebab-case: a-z, 0-9, hyphens only)',
      }),
    ),

  DeleteTag: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Delete a tag',
        description:
          'Soft deletes an existing tag by its key. This is an admin-only operation and affects ALL resources using this tag. The tag is marked as deleted but not permanently removed from the database.',
      }),
      ApiParam({
        name: 'tagKey',
        description: 'The unique key of the tag to delete',
        example: 'abcd1234',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 204,
        description:
          'Tag successfully deleted (soft delete). No content returned.',
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Admin permissions required' }),
      ApiNotFoundResponse({ description: 'Tag not found' }),
    ),
};
