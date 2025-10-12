import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

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

export const AppSwagger = {
  Controller: () => ApiTags('Health'),

  Health: () =>
    combineDecorators(
      ApiOperation({
        summary: 'Health check',
        description:
          'Returns the health status of the API and its dependencies (database, Redis). Status will be "healthy" if all services are up, "degraded" if some services are down, or "unhealthy" if critical services are down.',
      }),
      ApiResponse({
        status: 200,
        description:
          'Health status retrieved successfully. Always returns 200 OK even if services are down - check the status field for actual health.',
        schema: {
          type: 'object',
          required: ['status', 'version', 'timestamp', 'services'],
          properties: {
            status: {
              type: 'string',
              enum: ['healthy', 'degraded', 'unhealthy'],
              example: 'healthy',
              description:
                'Overall health: "healthy" = all up, "degraded" = some down, "unhealthy" = critical services down',
            },
            version: {
              type: 'string',
              example: '0.0.1',
              description: 'API version',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
              example: '2025-10-06T12:00:00.000Z',
              description:
                'ISO 8601 timestamp when the health check was performed',
            },
            services: {
              type: 'object',
              required: ['database', 'redis'],
              properties: {
                database: {
                  type: 'object',
                  required: ['status'],
                  properties: {
                    status: {
                      type: 'string',
                      enum: ['up', 'down'],
                      example: 'up',
                      description: 'Database connectivity status',
                    },
                    responseTime: {
                      type: 'number',
                      example: 5,
                      description: 'Database response time in milliseconds',
                    },
                    error: {
                      type: 'string',
                      example: 'Connection timeout',
                      description: 'Error message when status is "down"',
                    },
                  },
                },
                redis: {
                  type: 'object',
                  required: ['status'],
                  properties: {
                    status: {
                      type: 'string',
                      enum: ['up', 'down'],
                      example: 'up',
                      description: 'Redis connectivity status',
                    },
                    responseTime: {
                      type: 'number',
                      example: 2,
                      description: 'Redis response time in milliseconds',
                    },
                    error: {
                      type: 'string',
                      example: 'Connection refused',
                      description: 'Error message when status is "down"',
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ),
};
