# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Comprehensive test suite with 84%+ coverage (375 tests)
- Contributing guidelines (CONTRIBUTING.md)
- Code of Conduct (CODE_OF_CONDUCT.md)
- Security policy (SECURITY.md) with security contact
- Complete README with Getting Started guide
- GitHub issue templates (bug report, feature request, question)
- GitHub Pull Request template
- Postman collections for all API endpoints
- API documentation with Swagger/OpenAPI and ReDoc

### Changed
- Updated Swagger documentation to match controller parameter names
- Standardized Postman collections with correct routes and variable names
- Improved test coverage across all modules

### Fixed
- Fixed duplicate Swagger decorators in crux.swagger.ts and theme.swagger.ts
- Fixed parameter naming inconsistencies in Swagger documentation
- Corrected Postman collection routes to use proper parameter patterns

## [0.0.1] - 2025-01-07

### Added
- Initial release
- Core Crux management system
- Four dimensional relationships (Gates, Gardens, Growth, Grafts)
- Tag system for resource labeling
- Path system for organizing cruxes
- Authentication with JWT and refresh tokens
- Email-based passwordless authentication
- Author and account management
- Redis caching layer
- Pagination support for list endpoints
- Comprehensive API documentation

### Technical
- NestJS framework
- TypeScript
- PostgreSQL
- Redis for session management
- Knex.js for migrations
- Jest for testing
- ESLint and Prettier for code quality

[Unreleased]: https://github.com/CruxGarden/api/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/CruxGarden/api/releases/tag/v0.0.1
