# Contributing to Crux Garden API

This repository contains the hosted API and the packaged local runtime used by the
Electron desktop app. Start with the [local-runtime source map and decision
boundaries](README.md#local-runtime) and the public [app architecture guide](https://github.com/CruxGarden/app/blob/main/docs/architecture.md).
These references include the necessary vocabulary and ownership rules; no private
parent workspace is needed.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Coding Standards](#coding-standards)
- [Local Runtime Changes](#local-runtime-changes)
- [Testing Guidelines](#testing-guidelines)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)

## Code of Conduct

This project adheres to a code of conduct that all contributors are expected to follow. Please be respectful and constructive in all interactions.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally
3. Set up the development environment (see below)
4. Create a feature branch for your changes
5. Make your changes and commit them
6. Push to your fork and submit a pull request

## Development Setup

### Prerequisites

- Node.js 22 (see `.nvmrc`)
- Docker (recommended) or PostgreSQL and Redis

### Credential-free verification

For contribution work that does not need a running development server:

```bash
nvm use
npm ci                      # includes the API build via prepare
npm run verify              # Docker must be running for disposable PostgreSQL fixtures
```

This path requires no `.env`, AWS keys, paid provider or running development database.
It runs lint, unit/native tests, HTTP integration tests, build and the packaged local
runtime smoke check. Do not replace the fixture database URL with your own Garden or
production database. Native modules need a supported compiler toolchain if a prebuilt
binary is unavailable. Use the server setup below only when you need interactive HTTP
work; missing AWS configuration uses mocks, not real email or object delivery.

### Installation

#### Option 1: With Docker (Recommended)

```bash
# Copy environment template
cp .env.example .env

# Edit .env and set your JWT_SECRET (minimum 32 characters)
# Other variables have sensible defaults or will run in mock mode

# Install dependencies, start Docker containers, run migrations
npm run setup

# Start development server
npm run dev
```

#### Option 2: Without Docker

Using your own PostgreSQL and Redis:

```bash
# Copy environment template
cp .env.example .env

# Update .env with your database and Redis URLs:
# DATABASE_URL=postgresql://user:password@localhost:5432/cruxgarden
# REDIS_URL=redis://localhost:6379
# JWT_SECRET=your-secret-key-minimum-32-characters

# Install dependencies
npm ci

# Run migrations
npm run migrate:dev

# Start development server
npm run start:dev
```

The API will be available at `http://localhost:3000`. Visit `http://localhost:3000/docs` for interactive API documentation.

### Environment Variables

**Required:**

- `JWT_SECRET` - JWT token signing secret (minimum 32 characters)

**Database & Cache** (auto-configured with Docker):

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string

**AWS Services** (optional - runs in mock mode if not configured):

- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `AWS_REGION` - AWS region (e.g., `us-east-1`)
- `AWS_SES_FROM_EMAIL` - Email sender address
- `AWS_S3_ARTIFACTS_BUCKET` - S3 bucket for artifact storage

Without AWS credentials, emails and file operations are logged to console. See `.env.example` for additional configuration options.

## How to Contribute

### Reporting Bugs

- Use the GitHub issue tracker
- Include a clear title and description
- Provide steps to reproduce the issue
- Include relevant logs, error messages, or screenshots
- Specify your environment (OS, Node version, etc.)

### Suggesting Features

- Use the GitHub issue tracker
- Clearly describe the feature and its use case
- Explain why this feature would be useful
- Consider whether it fits the project's scope and goals

### Code Contributions

1. **Find an issue** - Look for issues labeled `good first issue` or `help wanted`
2. **Discuss** - Comment on the issue to let others know you're working on it
3. **Develop** - Create a feature branch and implement your changes
4. **Test** - Write tests for your changes (see Testing Guidelines)
5. **Submit** - Open a pull request with a clear description

## Coding Standards

### TypeScript

- Follow the existing code style (enforced by ESLint and Prettier)
- Use TypeScript strict mode
- Avoid `any` types where possible
- Document complex functions with JSDoc comments

### NestJS Conventions

- Follow NestJS architectural patterns
- Use dependency injection
- Create DTOs for all request/response bodies
- Implement proper validation using `class-validator`
- Use guards for authentication and authorization

### Code Style

```bash
# Format code with Prettier
npm run format

# Lint code with ESLint
npm run lint
```

### File Organization

- Controllers: Handle HTTP requests and responses
- Services: Contain business logic
- Repositories: Handle database operations
- DTOs: Define data transfer objects
- Entities: Define data models
- Guards: Handle authentication/authorization
- Swagger: API documentation decorators

## Local Runtime Changes

Use [src/local/index.ts](src/local/index.ts) as the package boundary and
[graph-runtime.ts](src/local/graph-runtime.ts) as the lifecycle/command entry point.
Keep validation and transactions inside the runtime; the desktop supplies trusted
filesystem hosts through the typed contract. Do not implement a competing renderer
SQL writer or silently fall back to a different store when a command is unavailable.

Preserve owner/revision capture, file integrity, retained Task/history references,
refusal-before-mutation and restart/recovery behavior. Add focused regressions to
the native suites under `src/local/` for a changed contract. Use actual SQLite and
filesystem boundaries for persistence/fault assertions; mocks are appropriate for
external providers, not substitutes for the database owner under test.

Run `npm run verify`: lint, unit tests, HTTP integration tests, build and the actual
packaged-runtime smoke check. HTTP/PostgreSQL integration fixtures require Docker;
they start disposable databases rather than using a developer's existing database.
`npm run build:local` produces the runtime package directory; `npm run verify:local`
checks a compiled package. Keep provenance and license materials with the archive.

When the exported contract changes, coordinate the app's typed IPC adapter,
renderer consumer and actual-desktop journey. Install the same runtime archive in
both app and Electron manifests/lockfiles and verify both environments; Node and
Electron native binaries must remain separate. Publishing an HTTP deployment and
installing a desktop runtime are independent release actions.

## Testing Guidelines

### Behavior coverage

- Preserve existing expected-behavior assertions when changing implementation.
- Add the smallest meaningful regression for changed behavior, including refusal and retry.
- Use real PostgreSQL HTTP fixtures for persistence/authorization changes, and the actual
  native SQLite runtime for local commands; mocks belong at external provider boundaries.
- For retained state, include restart/readback and rollback checks. Runtime changes also
  need affected app/Electron acceptance before being considered shipped.
- Coverage percentages locate untested code; they do not prove complete user-story coverage.
  Fixture-backed email, billing and AI tests do not certify live delivery, spend or quality.

### Writing Tests

```bash
# Run unit tests
npm test

# Run integration tests
npm run test:integration

# Run all tests (unit + integration)
npm run test:all

# Run tests in watch mode
npm run test:watch

# Run tests for specific module
npm run test:module <module-name>

# Run tests with coverage (excludes .spec, swagger, DTOs, entities)
npm run test:coverage
```

### Test Structure

- Use `describe` blocks to group related tests
- Use clear, descriptive test names
- Follow the Arrange-Act-Assert pattern
- Mock external services where deterministic responses are needed; keep the database owner real for persistence assertions
- Test one thing per test case

### Example Test

```typescript
describe('ExampleService', () => {
  let service: ExampleService;
  let repository: jest.Mocked<ExampleRepository>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ExampleService,
        { provide: ExampleRepository, useValue: mockRepository },
      ],
    }).compile();

    service = module.get<ExampleService>(ExampleService);
    repository = module.get(ExampleRepository);
  });

  describe('findById', () => {
    it('should return entity when found', async () => {
      // Arrange
      repository.findBy.mockResolvedValue({ data: mockData, error: null });

      // Act
      const result = await service.findById('id-123');

      // Assert
      expect(result.id).toBe('id-123');
      expect(repository.findBy).toHaveBeenCalledWith('id', 'id-123');
    });

    it('should throw NotFoundException when not found', async () => {
      // Arrange
      repository.findBy.mockResolvedValue({ data: null, error: null });

      // Act & Assert
      await expect(service.findById('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
```

## Commit Guidelines

### Commit Message Format

Follow the conventional commits specification:

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Examples

```
feat(auth): add refresh token rotation

Implements automatic refresh token rotation for improved security.
Tokens are now rotated on each refresh request and old tokens
are invalidated.

Closes #123
```

```
fix(crux): handle null dimensions in query

Fixes an issue where querying cruxes with null dimensions
would cause a database error.
```

```
test(tag): add missing coverage for syncTags error cases

Adds tests for error handling in the tag sync functionality,
improving coverage from 88% to 93%.
```

## Pull Request Process

### Before Submitting

1. Ensure your code follows the coding standards
2. Run the linter and formatter: `npm run lint && npm run format`
3. Write or update tests for your changes
4. Run the complete gate: `npm run verify`; include affected desktop acceptance for runtime changes
5. Update documentation if needed
6. Rebase your branch on the latest main branch

### PR Description

Include the following in your PR description:

- **Summary**: Brief description of changes
- **Motivation**: Why these changes are needed
- **Changes**: List of specific changes made
- **Testing**: How you tested the changes
- **Screenshots**: If applicable (UI changes)
- **Breaking Changes**: Any breaking changes
- **Related Issues**: Reference related issues (Closes #123)

### PR Template

```markdown
## Summary

Brief description of the changes

## Motivation

Why are these changes needed?

## Changes

- Change 1
- Change 2
- Change 3

## Testing

- [ ] Unit tests added/updated
- [ ] All tests passing
- [ ] Manual testing completed

## Checklist

- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
- [ ] No new warnings generated
- [ ] Tests added with good coverage
- [ ] All tests pass locally
```

### Review Process

1. Automated checks must pass (linting, tests, build)
2. At least one maintainer review is required
3. Address all review comments
4. Ensure CI/CD pipeline passes
5. Maintainer will merge once approved

### After Your PR is Merged

- Delete your feature branch
- Pull the latest changes from main
- Celebrate! 🎉

## Questions?

If you have questions or need help:

- **Ask questions** via [GitHub Discussions](https://github.com/CruxGarden/api/discussions)
- **Report bugs** via [GitHub Issues](https://github.com/CruxGarden/api/issues)
- **Request features** via [GitHub Issues](https://github.com/CruxGarden/api/issues)
- Review existing issues and documentation
- Reach out to maintainers

Thank you for contributing to Crux Garden!

## Small contribution candidates

Confirm the current gap in an issue before starting. Keep the first PR bounded.

| Candidate                      | Expected result                                                            | Acceptance boundary                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Public runtime map             | Add a worked create → write → read example using exported types            | Execute it against the built local package in scratch storage; no app checkout required                                    |
| Refusal contract documentation | Document one controller's actual error responses beside its Swagger schema | Trace existing HTTP integration assertions; add a real HTTP case only if the behavior lacks coverage                       |
| Setup diagnostics              | Improve one reproducible missing-service or configuration error            | Demonstrate the failing clean setup and actionable error, without logging credentials or altering production configuration |

Large ownership changes should start with a maintainer-reviewed slice and preserved
native/HTTP tests. Repository method mocks alone do not validate transactions or races.

## Support scope

Use issues for reproducible failures and scoped proposals, including revision, runtime,
expected/actual behavior and redacted logs. Support is best effort without a response or
merge deadline; security reports follow `SECURITY.md`. Review requires the full gate,
relevant cross-repository acceptance and a clear statement of anything untested.
A merged source change does not itself deploy the hosted API or install a new desktop
runtime. Maintainers handle those release actions separately.

## Dependency checks

Run `npm audit` as well as the verification gate when changing dependencies. The
October 3 contributor check cleared twelve development-tooling findings by aligning
`@types/jest` with the existing Jest 30 runner and updating TypeScript ESLint 8 and
ts-loader 9. No production/shared package version changed, and the compiled local
runtime content hash stayed unchanged. The full native/HTTP gate passed afterward.
This dated zero-finding audit is a package inventory result, not a security guarantee
or a statement about the app's separate dependencies. Avoid force-downgrading tools
just to suppress an advisory; inspect the dependency path and validate the replacement.
