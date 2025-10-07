<div align="center">
  <img src=".github/banner.jpg" alt="Crux Garden - Where Ideas Grow" width="100%">

  <p>
    <a href="https://github.com/CruxGarden/api/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
    <a href="https://github.com/CruxGarden/api/issues"><img src="https://img.shields.io/github/issues/CruxGarden/api" alt="Issues"></a>
    <a href="https://github.com/CruxGarden/api/stargazers"><img src="https://img.shields.io/github/stars/CruxGarden/api" alt="Stars"></a>
  </p>
</div>

## What is Crux Garden?

Crux Garden is a model of how ideas manifest and develop over time. It is a pattern of mind and memory that exists independent of any medium, though it has been realized as an open-source technology for the modern web.

The heart of the model is the **Crux**, an atomic representation of an idea. In our implementation, a Crux can be text, media, code, or any digital content worth preserving.

But Cruxes, just like ideas, don't exist in isolation. Ideas have origins. They come from somewhere. More specifically, ideas come from other ideas. And correspondingly, ideas lead to other ideas.

So it is with Cruxes.

There are four relationships that Cruxes can have with other Cruxes. These are called **Dimensions**.

- **GATES** — Cruxes which influenced or inspired a Crux; its origins and sources.
- **GARDENS** — Cruxes which emerged or grew from a Crux, its creations and consequences.
- **GROWTH** — Cruxes which capture how a Crux developed over time, its transformation and refinement.
- **GRAFTS** — Cruxes which connect to a Crux laterally, its associations and resonances.

These four Dimensions capture the fundamental ways that Cruxes, or ideas, relate to one another.

## Getting Started

### Prerequisites

- **Node.js** v22 or higher
- **PostgreSQL** database (any provider - Supabase, AWS RDS, local, etc.)
- **Redis** for caching and sessions
- **npm** or **yarn** package manager

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/CruxGarden/api.git
   cd api
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your PostgreSQL connection string and other configuration
   ```

4. **Run database migrations**
   ```bash
   npm run migrate:latest
   ```

5. **Start the development server**
   ```bash
   npm run crux:dev
   ```

The API will be available at `http://localhost:3000`

### Configuration

Required environment variables (see `.env.example` for details):

- `JWT_SECRET` - Secret key for JWT tokens (minimum 32 characters)
- `DATABASE_URL` - PostgreSQL connection string (e.g., `postgresql://user:password@localhost:5432/cruxgarden`)
- `REDIS_URL` - Redis connection string (e.g., `redis://localhost:6379`)
- `AWS_ACCESS_KEY_ID` - AWS credentials for SES email service
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `AWS_REGION` - AWS region

Optional environment variables:

- `PORT` - Server port (default: 3000)
- `CORS_ORIGIN` - Allowed CORS origins (default: *)
- `RATE_LIMIT_TTL` - Rate limit time window in ms (default: 60000)
- `RATE_LIMIT_MAX` - Max requests per window (default: 100)

### Development Commands

```bash
# Development
npm run crux:dev          # Start with hot reload
npm run crux:debug        # Start in debug mode

# Testing
npm test                  # Run unit tests
npm run test:watch        # Run tests in watch mode
npm run test:cov          # Run tests with coverage
npm run test:e2e          # Run end-to-end tests

# Code Quality
npm run lint              # Run ESLint with auto-fix
npm run format            # Format code with Prettier

# Database
npm run migrate:latest    # Run migrations
npm run migrate:rollback  # Rollback last migration
npm run migrate:make      # Create new migration

# Production
npm run crux:build        # Build for production
npm run crux:start:prod   # Start production server
```

## API Documentation

Once the server is running, access the interactive API documentation:

- **Swagger UI**: http://localhost:3000/api
- **ReDoc**: http://localhost:3000/api-docs

Or explore the API using the Postman collections in the `/postman` directory.

## Architecture

### Tech Stack

- **Framework**: NestJS
- **Database**: PostgreSQL
- **Cache**: Redis
- **Authentication**: JWT with refresh tokens
- **Validation**: class-validator & class-transformer
- **Documentation**: Swagger/OpenAPI
- **Testing**: Jest

### Module Structure

- `AuthModule` - Authentication and authorization
- `AccountModule` - User account management
- `AuthorModule` - Author profiles and metadata
- `CruxModule` - Core crux management
- `DimensionModule` - Relationships between cruxes
- `PathModule` - Collections and sequences of cruxes
- `TagModule` - Resource-agnostic tagging system
- `ThemeModule` - Visual theme customization
- `CommonModule` - Shared services (database, email, Redis)

## Contributing

Please read our [Contributing Guide](CONTRIBUTING.md) for details on:

- Setting up your development environment
- Code style and standards
- Testing guidelines
- Commit message conventions
- Pull request process

## Security

If you discover a security vulnerability, please follow our [Security Policy](SECURITY.md) to report it responsibly.

## Community

- **Report bugs** via [GitHub Issues](https://github.com/CruxGarden/api/issues)
- **Request features** via [GitHub Issues](https://github.com/CruxGarden/api/issues)
- **Ask questions** via [GitHub Discussions](https://github.com/CruxGarden/api/discussions)
- **Contribute** by submitting pull requests

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
