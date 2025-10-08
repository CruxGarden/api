# Contributing to Crux Garden API

Thank you for your interest in contributing to Crux Garden API! This document provides guidelines and instructions for contributing to this project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Coding Standards](#coding-standards)
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

- Node.js (v18 or higher)
- npm or yarn
- PostgreSQL
- Redis (for caching)

### Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your local configuration

# Run migrations and seeds
npm run migrate:latest && npm run migrate:seed

# Start development server
npm run start:dev
```

### Environment Variables

Ensure you have the following environment variables configured in your `.env` file:

- `JWT_SECRET` - Secret key for JWT tokens
- `DATABASE_URL` - Postgres database connection string
- `REDIS_URL` - Redis connection string
- `FROM_EMAIL_ADDRESS` - Email service configuration for SES
- `AWS_ACCESS_KEY_ID` - AWS Config
- `AWS_SECRET_ACCESS_KEY` - AWS Config
- `AWS_REGION` - AWS Config

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

## Testing Guidelines

### Test Coverage

- All new features must include unit tests
- Aim for >90% code coverage for new code
- Test both success and error cases
- Test edge cases and boundary conditions

### Writing Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests for specific module
npm run test:module <module-name>

# Run tests with coverage
npm run test:cov
```

### Test Structure

- Use `describe` blocks to group related tests
- Use clear, descriptive test names
- Follow the Arrange-Act-Assert pattern
- Mock external dependencies
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
4. Ensure all tests pass: `npm test`
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

- Open a discussion on GitHub
- Review existing issues and documentation
- Reach out to maintainers

Thank you for contributing to Crux Garden!
