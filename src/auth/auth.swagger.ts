import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { AuthCodeDto } from './dto/auth-code.dto';
import { AuthLoginDto } from './dto/auth-login.dto';
import { AuthTokenDto } from './dto/auth-token.dto';

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

export const AuthSwagger = {
  Controller: () => ApiTags('Authentication'),

  RequestCode: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Request authentication code',
        description:
          'Sends an authentication code to the provided email address.',
      }),
      ApiBody({ type: AuthCodeDto }),
      ApiResponse({
        status: 200,
        description: 'Authentication code sent successfully',
        schema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              example: 'Auth Code emailed to user@example.com',
            },
          },
        },
      }),
      ApiBadRequestResponse({ description: 'Invalid email format' }),
    ),

  Login: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Login with email and code',
        description:
          'Authenticates a user using email and authentication code. Creates account and author if first time login.',
      }),
      ApiBody({ type: AuthLoginDto }),
      ApiResponse({
        status: 200,
        description: 'Login successful',
        schema: {
          type: 'object',
          properties: {
            accessToken: {
              type: 'string',
              example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
              description: 'JWT access token valid for 1 hour',
            },
            refreshToken: {
              type: 'string',
              example: 'gHtdgqnJiEaBcDef',
              description: 'Refresh token valid for 14 days',
            },
            expiresIn: {
              type: 'number',
              example: 3600,
              description: 'Access token expiration time in seconds',
            },
          },
        },
      }),
      ApiUnauthorizedResponse({
        description: 'Invalid email or authentication code',
      }),
      ApiBadRequestResponse({ description: 'Invalid request format' }),
    ),

  Token: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Refresh access token',
        description: 'Gets a new access token using a refresh token.',
      }),
      ApiBody({ type: AuthTokenDto }),
      ApiResponse({
        status: 200,
        description: 'Token refreshed successfully',
        schema: {
          type: 'object',
          properties: {
            accessToken: {
              type: 'string',
              example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
              description: 'New JWT access token valid for 1 hour',
            },
            refreshToken: {
              type: 'string',
              example: 'gHtdgqnJiEaBcDef',
              description: 'New refresh token valid for 14 days',
            },
            expiresIn: {
              type: 'number',
              example: 3600,
              description: 'Access token expiration time in seconds',
            },
          },
        },
      }),
      ApiUnauthorizedResponse({
        description: 'Invalid or expired refresh token',
      }),
      ApiBadRequestResponse({ description: 'Invalid request format' }),
    ),

  Profile: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Get user profile',
        description: "Retrieves the authenticated user's account profile.",
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 200,
        description: 'User profile retrieved successfully',
        schema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440000',
            },
            email: {
              type: 'string',
              format: 'email',
              example: 'user@example.com',
            },
            role: {
              type: 'string',
              enum: ['admin', 'author', 'keeper'],
              example: 'author',
            },
            created: {
              type: 'string',
              format: 'date-time',
              example: '2024-01-01T00:00:00.000Z',
            },
            updated: {
              type: 'string',
              format: 'date-time',
              example: '2024-01-01T00:00:00.000Z',
            },
          },
        },
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
      ApiNotFoundResponse({ description: 'User profile not found' }),
    ),

  Logout: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Logout user',
        description:
          'Logs out the authenticated user and invalidates their grant tokens.',
      }),
      ApiBearerAuth(),
      ApiResponse({
        status: 204,
        description: 'Logout successful - no content returned',
      }),
      ApiUnauthorizedResponse({ description: 'Authentication required' }),
    ),
};
