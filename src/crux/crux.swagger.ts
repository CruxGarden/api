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
  ApiBadRequestResponse,
  ApiConsumes,
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
              description: {
                type: 'string',
                example: 'A brief description of this crux',
              },
              data: {
                type: 'string',
                example: 'This is the content of my crux',
              },
              type: { type: 'string', example: 'text' },
              kind: { type: 'string', example: 'note' },
              status: { type: 'string', example: 'living' },
              visibility: { type: 'string', example: 'public' },
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
              meta: { type: 'object', example: {} },
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
            description: {
              type: 'string',
              example: 'A brief description of this crux',
            },
            data: { type: 'string', example: 'This is the content of my crux' },
            type: { type: 'string', example: 'text' },
            kind: { type: 'string', example: 'note' },
            status: { type: 'string', example: 'living' },
            visibility: { type: 'string', example: 'unlisted' },
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
            meta: { type: 'object', example: {} },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
    ),

  GetByIdentifier: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get a crux by identifier',
        description:
          'Retrieves a specific crux by its UUID, key, or slug (prefixed with +).',
      }),
      ApiParam({
        name: 'identifier',
        description: 'The UUID, key, or slug (with + prefix) of the crux',
        examples: {
          uuid: {
            value: 'be464476-892a-40f5-b26b-ee340f060c72',
            description: 'UUID',
          },
          key: { value: 'abc123', description: 'Short key' },
          slug: { value: '+my-crux', description: 'Slug with + prefix' },
        },
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
            description: {
              type: 'string',
              example: 'A brief description of this crux',
            },
            data: { type: 'string', example: 'This is the content of my crux' },
            type: { type: 'string', example: 'text' },
            kind: { type: 'string', example: 'note' },
            status: { type: 'string', example: 'living' },
            visibility: { type: 'string', example: 'unlisted' },
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
            meta: { type: 'object', example: {} },
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
            description: { type: 'string', example: 'Updated description' },
            data: { type: 'string', example: 'This is the updated content' },
            type: { type: 'string', example: 'text' },
            kind: { type: 'string', example: 'note' },
            status: { type: 'string', example: 'living' },
            visibility: { type: 'string', example: 'public' },
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
            meta: { type: 'object', example: {} },
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
              homeId: { type: 'string', format: 'uuid' },
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
          'Retrieves all dimensional relationships where this crux is the source. Dimensions can be filtered by type and optionally include embedded source/target crux data.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the source crux',
        example: 'abc123',
      }),
      ApiQuery({
        name: 'type',
        required: false,
        enum: ['gate', 'garden', 'growth', 'graft'],
        description:
          'Filter dimensions by type. Gates are origins/sources, Gardens are creations/consequences, Growth is evolution over time, Grafts are lateral connections.',
        example: 'gate',
      }),
      ApiQuery({
        name: 'embed',
        required: false,
        description:
          'Control which related crux data to embed in the response. Can be a single value or comma-separated list (order-agnostic, case-insensitive). Default: "target"',
        examples: {
          default: {
            value: 'target',
            description:
              'Default - embeds target crux only (key, slug, title, data)',
          },
          none: {
            value: 'none',
            description: 'No embedded data - returns only IDs',
          },
          source: {
            value: 'source',
            description: 'Embeds source crux data only',
          },
          both: {
            value: 'source,target',
            description: 'Embeds both source and target crux data',
          },
          bothReversed: {
            value: 'target,source',
            description: 'Order does not matter - same as source,target',
          },
        },
      }),
      ApiResponse({
        status: 200,
        description: 'Dimensions retrieved successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              key: { type: 'string', example: 'dim_abc123' },
              sourceId: {
                type: 'string',
                format: 'uuid',
                description: 'Always present - ID of the source crux',
              },
              targetId: {
                type: 'string',
                format: 'uuid',
                description: 'Always present - ID of the target crux',
              },
              type: {
                type: 'string',
                enum: ['gate', 'garden', 'growth', 'graft'],
                example: 'gate',
              },
              kind: { type: 'string', example: 'inspiration' },
              weight: { type: 'number', example: 1 },
              note: { type: 'string', example: 'This inspired that idea' },
              created: { type: 'string', format: 'date-time' },
              updated: { type: 'string', format: 'date-time' },
              source: {
                type: 'object',
                description:
                  'Embedded source crux data (only present if embed includes "source")',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  key: { type: 'string', example: 'crux_abc' },
                  slug: { type: 'string', example: 'my-source-crux' },
                  title: { type: 'string', example: 'Source Crux Title' },
                  data: { type: 'string', example: 'Source crux content...' },
                },
              },
              target: {
                type: 'object',
                description:
                  'Embedded target crux data (present by default, excluded if embed=none or embed=source)',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  key: { type: 'string', example: 'crux_xyz' },
                  slug: { type: 'string', example: 'my-target-crux' },
                  title: { type: 'string', example: 'Target Crux Title' },
                  data: { type: 'string', example: 'Target crux content...' },
                },
              },
            },
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

  GetAttachments: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get all attachments for a crux',
        description:
          'Retrieves all file attachments associated with a specific crux.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the crux',
        example: 'abc123',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'Attachments retrieved successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              key: { type: 'string', example: 'TKSoWfISLG_' },
              type: { type: 'string', example: 'image' },
              kind: { type: 'string', example: 'photo' },
              filename: { type: 'string', example: 'screenshot.png' },
              mimeType: { type: 'string', example: 'image/png' },
              size: { type: 'number', example: 1024000 },
              created: { type: 'string', format: 'date-time' },
              updated: { type: 'string', format: 'date-time' },
            },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
    ),

  CreateAttachment: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Upload a file attachment to a crux',
        description:
          'Uploads a file and creates an attachment record for a crux. Max file size: 50MB. Requires authentication and crux ownership.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the crux',
        example: 'abc123',
      }),
      ApiConsumes('multipart/form-data'),
      ApiBody({
        schema: {
          type: 'object',
          required: ['file', 'type', 'kind'],
          properties: {
            file: {
              type: 'string',
              format: 'binary',
              description: 'The file to upload (max 50MB)',
            },
            type: {
              type: 'string',
              description: 'Type of attachment',
              example: 'image',
            },
            kind: {
              type: 'string',
              description: 'Kind of attachment',
              example: 'photo',
            },
            meta: {
              type: 'string',
              description: 'Optional metadata as JSON string',
              example: '{"width": 1920, "height": 1080}',
            },
          },
        },
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 201,
        description: 'Attachment uploaded successfully',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            key: { type: 'string', example: 'TKSoWfISLG_' },
            type: { type: 'string', example: 'image' },
            kind: { type: 'string', example: 'photo' },
            filename: { type: 'string', example: 'screenshot.png' },
            mimeType: { type: 'string', example: 'image/png' },
            size: { type: 'number', example: 1024000 },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({
        description: 'No permission to manage this crux',
      }),
      ApiNotFoundResponse({ description: 'Crux not found' }),
      ApiBadRequestResponse({
        description:
          'Invalid file, exceeds size limit, or missing required fields',
      }),
    ),

  DownloadAttachment: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Download an attachment file',
        description:
          'Downloads the file for a specific attachment. Returns the file with appropriate Content-Type and Content-Disposition headers. Cached for 1 year.',
      }),
      ApiParam({
        name: 'cruxKey',
        description: 'The unique key of the crux',
        example: 'abc123',
      }),
      ApiParam({
        name: 'attachmentKey',
        description: 'The unique key of the attachment',
        example: 'TKSoWfISLG_',
      }),
      ApiResponse({
        status: 200,
        description: 'Attachment file downloaded successfully',
        content: {
          'application/octet-stream': {
            schema: {
              type: 'string',
              format: 'binary',
            },
          },
        },
        headers: {
          'Content-Type': {
            description: 'MIME type of the file',
            schema: { type: 'string' },
          },
          'Content-Disposition': {
            description: 'Attachment filename',
            schema: { type: 'string' },
          },
          'Cache-Control': {
            description: 'Cache control header',
            schema: { type: 'string', example: 'max-age=31536000' },
          },
        },
      }),
      ApiNotFoundResponse({
        description:
          'Crux or attachment not found, or attachment does not belong to this crux',
      }),
    ),
};
