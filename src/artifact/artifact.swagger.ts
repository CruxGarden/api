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
  ApiConsumes,
} from '@nestjs/swagger';
import { CreateArtifactDto } from './dto/create-artifact.dto';

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

export const ArtifactSwagger = {
  Controller: () => ApiTags('Artifacts'),

  Create: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Create a new artifact',
        description:
          'Creates a new artifact with the provided data. Requires authentication.',
      }),
      ApiBody({ type: CreateArtifactDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 201,
        description: 'The artifact has been successfully created.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
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
        summary: 'Get all artifacts',
        description: 'Retrieves a paginated list of all artifacts.',
      }),
      ApiResponse({
        status: 200,
        description: 'List of artifacts retrieved successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
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
        summary: 'Get an artifact by ID',
        description: 'Retrieves a specific artifact by its UUID.',
      }),
      ApiParam({
        name: 'id',
        description: 'The UUID of the artifact',
        example: '550e8400-e29b-41d4-a716-446655440000',
      }),
      ApiResponse({
        status: 200,
        description: 'The artifact data',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
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
      ApiNotFoundResponse({ description: 'Artifact not found' }),
    ),

  Update: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Update an artifact',
        description:
          'Updates an existing artifact. Optionally upload a new file to replace the existing one. Max file size: 50MB. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'id',
        description: 'The UUID of the artifact to update',
        example: '550e8400-e29b-41d4-a716-446655440000',
      }),
      ApiConsumes('multipart/form-data'),
      ApiBody({
        schema: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              format: 'binary',
              description: 'Optional: New file to replace existing (max 50MB)',
            },
            type: {
              type: 'string',
              description: 'Type of artifact',
              example: 'image',
            },
            kind: {
              type: 'string',
              description: 'Kind of artifact',
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
        status: 200,
        description: 'The artifact has been successfully updated.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
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
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Artifact not found' }),
      ApiBadRequestResponse({
        description: 'Invalid input data or file exceeds size limit',
      }),
    ),

  Delete: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Delete an artifact',
        description:
          'Deletes an existing artifact. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'id',
        description: 'The UUID of the artifact to delete',
        example: '550e8400-e29b-41d4-a716-446655440000',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 204,
        description: 'The artifact has been successfully deleted.',
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Artifact not found' }),
    ),
};
