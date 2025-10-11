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
import { CreateAttachmentDto } from './dto/create-attachment.dto';
import { UpdateAttachmentDto } from './dto/update-attachment.dto';

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

export const AttachmentSwagger = {
  Controller: () => ApiTags('Attachments'),

  Create: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Create a new attachment',
        description:
          'Creates a new attachment with the provided data. Requires authentication.',
      }),
      ApiBody({ type: CreateAttachmentDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 201,
        description: 'The attachment has been successfully created.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            key: { type: 'string', example: 'TKSoWfISLG_' },
            type: { type: 'string', example: 'image' },
            kind: { type: 'string', example: 'photo' },
            meta: { type: 'object' },
            resourceId: { type: 'string', format: 'uuid' },
            resourceType: { type: 'string', example: 'crux' },
            authorId: { type: 'string', format: 'uuid' },
            homeId: { type: 'string', format: 'uuid' },
            encoding: { type: 'string', example: '7bit' },
            mimeType: { type: 'string', example: 'image/png' },
            filename: { type: 'string', example: 'screenshot.png' },
            size: { type: 'number', example: 1024000 },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiBadRequestResponse({ description: 'Invalid input data' }),
    ),

  GetAll: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get all attachments',
        description: 'Retrieves a paginated list of all attachments.',
      }),
      ApiResponse({
        status: 200,
        description: 'List of attachments retrieved successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              key: { type: 'string' },
              type: { type: 'string', example: 'image' },
              kind: { type: 'string', example: 'photo' },
              resourceId: { type: 'string', format: 'uuid' },
              resourceType: { type: 'string', example: 'crux' },
              authorId: { type: 'string', format: 'uuid' },
              mimeType: { type: 'string', example: 'image/png' },
              filename: { type: 'string', example: 'screenshot.png' },
              size: { type: 'number' },
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
        summary: 'Get an attachment by key',
        description: 'Retrieves a specific attachment by its unique key.',
      }),
      ApiParam({
        name: 'attachmentKey',
        description: 'The unique key of the attachment',
        example: 'TKSoWfISLG_',
      }),
      ApiResponse({
        status: 200,
        description: 'The attachment data',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            key: { type: 'string' },
            type: { type: 'string', example: 'image' },
            kind: { type: 'string', example: 'photo' },
            meta: { type: 'object' },
            resourceId: { type: 'string', format: 'uuid' },
            resourceType: { type: 'string', example: 'crux' },
            authorId: { type: 'string', format: 'uuid' },
            homeId: { type: 'string', format: 'uuid' },
            encoding: { type: 'string', example: '7bit' },
            mimeType: { type: 'string', example: 'image/png' },
            filename: { type: 'string', example: 'screenshot.png' },
            size: { type: 'number', example: 1024000 },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiNotFoundResponse({ description: 'Attachment not found' }),
    ),

  Update: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Update an attachment',
        description:
          'Updates an existing attachment with the provided data. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'attachmentKey',
        description: 'The unique key of the attachment to update',
        example: 'TKSoWfISLG_',
      }),
      ApiBody({ type: UpdateAttachmentDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'The attachment has been successfully updated.',
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Attachment not found' }),
      ApiBadRequestResponse({ description: 'Invalid input data' }),
    ),

  Delete: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Delete an attachment',
        description:
          'Deletes an existing attachment. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'attachmentKey',
        description: 'The unique key of the attachment to delete',
        example: 'TKSoWfISLG_',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 204,
        description: 'The attachment has been successfully deleted.',
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Attachment not found' }),
    ),
};
