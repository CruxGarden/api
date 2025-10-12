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
  ApiConflictResponse,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { CreateThemeDto } from './dto/create-theme.dto';
import { UpdateThemeDto } from './dto/update-theme.dto';

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

export const ThemeSwagger = {
  Controller: () => ApiTags('Themes'),

  Create: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Create a new theme',
        description:
          'Creates a new theme with the provided data. Requires authentication.',
      }),
      ApiBody({ type: CreateThemeDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 201,
        description: 'The theme has been successfully created.',
        schema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440000',
            },
            authorId: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440001',
            },
            homeId: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440002',
            },
            title: { type: 'string', example: 'Ocean Blue' },
            key: { type: 'string', example: 'ocean-blue' },
            description: {
              type: 'string',
              example: 'A calming blue theme inspired by ocean waters',
            },
            primaryColor: { type: 'string', example: '#2563eb' },
            secondaryColor: { type: 'string', example: '#3b82f6' },
            tertiaryColor: { type: 'string', example: '#60a5fa' },
            quaternaryColor: { type: 'string', example: '#93c5fd' },
            borderRadius: { type: 'string', example: '8px' },
            backgroundColor: { type: 'string', example: '#ffffff' },
            panelColor: { type: 'string', example: '#f5f5f5' },
            textColor: { type: 'string', example: '#000000' },
            font: { type: 'string', example: 'Inter' },
            mode: { type: 'string', example: 'light' },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiConflictResponse({
        description: 'Theme with this name or key already exists',
      }),
      ApiBadRequestResponse({ description: 'Invalid input data' }),
    ),

  GetAll: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get all themes',
        description: 'Retrieves a paginated list of all themes.',
      }),
      ApiResponse({
        status: 200,
        description: 'List of themes retrieved successfully',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              authorId: { type: 'string', format: 'uuid' },
              title: { type: 'string', example: 'Ocean Blue' },
              key: { type: 'string', example: 'ocean-blue' },
              description: { type: 'string' },
              primaryColor: { type: 'string', example: '#2563eb' },
              secondaryColor: { type: 'string', example: '#3b82f6' },
              tertiaryColor: { type: 'string', example: '#60a5fa' },
              quaternaryColor: { type: 'string', example: '#93c5fd' },
              borderRadius: { type: 'string', example: '8px' },
              backgroundColor: { type: 'string', example: '#ffffff' },
              panelColor: { type: 'string', example: '#f5f5f5' },
              textColor: { type: 'string', example: '#000000' },
              font: { type: 'string', example: 'Inter' },
              mode: { type: 'string', example: 'light' },
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
        summary: 'Get a theme by key',
        description: 'Retrieves a specific theme by its unique key.',
      }),
      ApiParam({
        name: 'themeKey',
        description: 'The unique key of the theme',
        example: 'ocean-blue',
      }),
      ApiResponse({
        status: 200,
        description: 'The theme data',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            authorId: { type: 'string', format: 'uuid' },
            title: { type: 'string', example: 'Ocean Blue' },
            key: { type: 'string', example: 'ocean-blue' },
            description: { type: 'string' },
            primaryColor: { type: 'string', example: '#2563eb' },
            secondaryColor: { type: 'string', example: '#3b82f6' },
            tertiaryColor: { type: 'string', example: '#60a5fa' },
            quaternaryColor: { type: 'string', example: '#93c5fd' },
            borderRadius: { type: 'string', example: '8px' },
            backgroundColor: { type: 'string', example: '#ffffff' },
            panelColor: { type: 'string', example: '#f5f5f5' },
            textColor: { type: 'string', example: '#000000' },
            font: { type: 'string', example: 'Inter' },
            mode: { type: 'string', example: 'light' },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiNotFoundResponse({ description: 'Theme not found' }),
    ),

  Update: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Update a theme',
        description:
          'Updates an existing theme with the provided data. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'themeKey',
        description: 'The unique key of the theme to update',
        example: 'ocean-blue',
      }),
      ApiBody({ type: UpdateThemeDto }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'The theme has been successfully updated.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            authorId: { type: 'string', format: 'uuid' },
            title: { type: 'string', example: 'Updated Ocean Blue' },
            key: { type: 'string', example: 'ocean-blue-updated' },
            description: { type: 'string' },
            primaryColor: { type: 'string', example: '#1e40af' },
            secondaryColor: { type: 'string', example: '#2563eb' },
            tertiaryColor: { type: 'string', example: '#3b82f6' },
            quaternaryColor: { type: 'string', example: '#60a5fa' },
            borderRadius: { type: 'string', example: '8px' },
            backgroundColor: { type: 'string', example: '#ffffff' },
            panelColor: { type: 'string', example: '#f5f5f5' },
            textColor: { type: 'string', example: '#000000' },
            font: { type: 'string', example: 'Inter' },
            mode: { type: 'string', example: 'light' },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiNotFoundResponse({ description: 'Theme not found' }),
      ApiConflictResponse({
        description: 'Theme with this name or key already exists',
      }),
      ApiBadRequestResponse({ description: 'Invalid input data' }),
    ),

  Delete: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Delete a theme',
        description:
          'Deletes an existing theme. Requires authentication and ownership.',
      }),
      ApiParam({
        name: 'themeKey',
        description: 'The unique key of the theme to delete',
        example: 'ocean-blue',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 204,
        description: 'The theme has been successfully deleted.',
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiForbiddenResponse({ description: 'Insufficient permissions' }),
      ApiNotFoundResponse({ description: 'Theme not found' }),
    ),

  GetTags: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get all tags for a theme',
        description: 'Retrieves all tags associated with a specific theme.',
      }),
      ApiParam({
        name: 'themeKey',
        description: 'The unique key of the theme',
        example: 'ocean-blue',
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
              label: { type: 'string', example: 'dark-mode' },
              resourceType: { type: 'string', example: 'theme' },
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
      ApiNotFoundResponse({ description: 'Theme not found' }),
    ),

  SyncTags: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Sync tags for a theme',
        description:
          'Replaces all tags for a theme with the provided list. Tags must be in kebab-case format.',
      }),
      ApiParam({
        name: 'themeKey',
        description: 'The unique key of the theme',
        example: 'ocean-blue',
      }),
      ApiBody({
        schema: {
          type: 'object',
          properties: {
            labels: {
              type: 'array',
              items: { type: 'string' },
              example: ['dark-mode', 'minimalist', 'professional'],
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
              label: { type: 'string', example: 'dark-mode' },
              resourceType: { type: 'string', example: 'theme' },
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
        description: 'No permission to manage tags for this theme',
      }),
      ApiNotFoundResponse({ description: 'Theme not found' }),
      ApiBadRequestResponse({
        description: 'Invalid tag label format (must be kebab-case)',
      }),
    ),
};
