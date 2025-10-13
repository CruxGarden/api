# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Crux Garden is a system for managing interconnected ideas through **Cruxes** (atomic ideas) and **Dimensions** (relationships between ideas). The four relationship types are:
- **GATES** — Origins and sources that influenced a Crux
- **GARDENS** — Creations and consequences that emerged from a Crux
- **GROWTH** — How a Crux developed over time
- **GRAFTS** — Lateral connections and associations

## Development Commands

```bash
# Development
npm run start:dev         # Start with hot reload
npm run start:debug       # Start in debug mode

# Testing
npm test                  # Run all unit tests
npm run test:watch        # Run tests in watch mode
npm run test:module       # Run specific module tests
npm run test:cov          # Run with coverage (excludes .spec, swagger, DTOs, entities)
npm run test:integration  # Run integration tests

# Code Quality
npm run lint              # ESLint with auto-fix
npm run format            # Format with Prettier

# Migrations & Seeds
npm run migrate:latest    # Run all migrations
npm run migrate:rollback  # Rollback last migration
npm run migrate:make <migration-name>  # Create new migration
npm run migrate:seed      # Run migrations + seeds
npm run seed:run          # Run seeds only

# Production
npm run build             # Build for production
npm run start:prod        # Start production server
```

## Architecture Patterns

### Module Structure
Each feature module follows a consistent layered architecture:

**Controller** → **Service** → **Repository** → **Database**

- **Controllers**: Handle HTTP, validate with DTOs, use AuthGuard for protected routes
- **Services**: Business logic, error handling, entity transformation
- **Repositories**: Database operations via Knex, return `RepositoryResponse<T>`
- **Entities**: Two versions - Raw (snake_case from DB) and Model (camelCase for API)

### Repository Pattern
All repositories return a consistent response type:
```typescript
interface RepositoryResponse<T> {
  data: T | null;
  error: Error | null;
}
```

Use helper functions from `src/common/helpers/repository-helpers.ts`:
- `success(data)` - Returns successful response
- `failure(error)` - Returns error response

### Case Conversion
Database uses `snake_case`, TypeScript uses `camelCase`:
- `toTableFields(obj)` - Convert camelCase to snake_case before DB writes
- `toEntityFields(obj)` - Convert snake_case to camelCase after DB reads
- Use `-raw.entity.ts` for database types, `.entity.ts` for API models

### Authentication & Authorization
- JWT-based auth with refresh tokens stored in Redis
- Use `@UseGuards(AuthGuard)` on protected routes
- Request object extended with `account: JwtPayload` containing user info
- Ownership checks compare `request.account.id` with resource's `authorId`

### Key Generation
The `KeyMaster` service provides two ID types:
- `generateId()` - UUID v4 for internal IDs
- `generateKey(length?)` - URL-safe short keys (11 chars, 64-char alphabet) for public-facing identifiers

### Database Access
- Use `DbService.query()` to get Knex instance
- Use `DbService.paginate()` for list endpoints (adds Link and Pagination headers)
- All deletes are soft deletes (set `deleted` timestamp)
- Always filter `whereNull('deleted')` when querying

### Dimension Relationships
Dimensions connect Cruxes bidirectionally:
- `sourceId` - The originating Crux
- `targetId` - The related Crux
- `type` - One of: 'gate', 'garden', 'growth', 'graft'
- `weight` - Optional ordering/priority
- Query via `/cruxes/:cruxKey/dimensions?type=<gate|garden|growth|graft>`

### Tags & Markers
- **Tags**: Resource-agnostic labels (attach to crux, path, theme)
- **Markers**: Ordered references from paths to cruxes
- Both use PUT sync pattern (delete all → recreate from body)

### Logging
Create child loggers in each class:
```typescript
this.logger = this.loggerService.createChildLogger('ClassName');
```

## Testing Guidelines

### Test Structure
- Tests colocated with source files as `*.spec.ts`
- Use NestJS testing utilities (`Test.createTestingModule`)
- Mock repositories with `jest.Mocked<RepositoryType>`
- Follow Arrange-Act-Assert pattern

### Coverage Rules
- Target >90% coverage for new code
- Coverage excludes: `.spec.ts`, `swagger.ts`, `module.ts`, DTOs, entities
- Test both success and error cases from repository responses

## Common Patterns

### Creating New Resources
1. Generate UUID with `KeyMaster.generateId()`
2. Generate URL-safe key with `KeyMaster.generateKey()`
3. Add `authorId` from `request.account.id`
4. Convert DTO to table fields with `toTableFields()`
5. Set `created` and `updated` timestamps

### Updating Resources
1. Verify ownership: `authorId === request.account.id`
2. Convert partial DTO with `toTableFields()`
3. Always update `updated` timestamp

### Querying with Relationships
- Repositories provide `findAllQuery()` for complex queries
- Services can join and filter before pagination
- Use Knex query builder methods directly on returned query

### Error Handling
- Services throw NestJS exceptions (NotFoundException, UnauthorizedException, etc.)
- Repositories catch DB errors and return them in `RepositoryResponse.error`
- Global exception filter formats all errors consistently

## File Organization

```
src/
├── common/               # Shared utilities
│   ├── guards/          # AuthGuard
│   ├── helpers/         # case-helpers, repository-helpers, etc.
│   ├── services/        # DbService, KeyMaster, RedisService, EmailService
│   └── types/           # Interfaces, enums, constants
├── <feature>/           # Feature modules (auth, crux, dimension, etc.)
│   ├── dto/            # Request/response DTOs
│   ├── entities/       # -raw.entity.ts (DB) and .entity.ts (API)
│   ├── *.controller.ts # HTTP routes
│   ├── *.service.ts    # Business logic
│   ├── *.repository.ts # Database access
│   ├── *.swagger.ts    # OpenAPI decorators
│   └── *.spec.ts       # Tests
```

## Environment Configuration

Required variables:
- `JWT_SECRET` - Min 32 chars for token signing
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` - For SES emails

See `.env.example` for complete list with defaults.
