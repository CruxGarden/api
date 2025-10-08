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

### Quick Start (Recommended)

**The fastest way to get started with everything included:**

```bash
# Clone the repo
git clone https://github.com/CruxGarden/api.git
cd api

# Copy environment template
cp .env.example .env
# Edit .env with your AWS credentials (see below)

# Start everything with Docker (includes Postgres + Redis)
cd docker
docker-compose up -d

# View logs
docker-compose logs -f api
```

**That's it!** The API will be running at <http://localhost:3000>

The only values you need to set in `.env` are:

- `JWT_SECRET` (any random 32+ character string)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (for email via SES)

### Prerequisites (for manual setup)

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

4. **Run database migrations and seeds**
   ```bash
   npm run migrate:latest && npm run migrate:seed
   ```

5. **Start the development server**
   ```bash
   npm run start:dev
   ```

The API will be available at <http://localhost:3000>

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
npm run start:dev         # Start with hot reload
npm run start:debug       # Start in debug mode

# Testing
npm test                  # Run unit tests
npm run test:watch        # Run tests in watch mode
npm run test:cov          # Run tests with coverage
npm run test:e2e          # Run end-to-end tests
npm run test:module       # Run specific module tests

# Code Quality
npm run lint              # Run ESLint with auto-fix
npm run format            # Format code with Prettier

# Database
npm run db:start          # Start local Supabase
npm run db:stop           # Stop local Supabase
npm run db:reset          # Reset Supabase database

# Migrations & Seeds
npm run migrate:latest    # Run migrations
npm run migrate:rollback  # Rollback last migration
npm run migrate:make      # Create new migration
npm run migrate:seed      # Run migrations + seeds
npm run seed:run          # Run seeds only

# Production
npm run build             # Build for production
npm run start:prod        # Start production server
```

## API Documentation

Once the server is running, access the interactive API documentation:

- **ReDoc**: <http://localhost:3000/docs>

Or explore the API using the Postman collections in the `/postman` directory.

## Docker Deployment

### Option 1: Everything Included (Recommended for Development)

**Start the API + PostgreSQL + Redis with one command:**

```bash
cd docker
docker-compose up -d
```

This gives you a complete running environment. No need to install or configure Postgres/Redis separately!

**Stop everything:**
```bash
docker-compose down
```

The API will be available at <http://localhost:3000>

**What's included:**

- API server on port 3000
- PostgreSQL database on port 5432
- Redis cache on port 6379
- Automatic health checks
- Data persistence with Docker volumes

### Option 2: Pre-built Image with External Services (Production)

**Use this when you have managed Postgres/Redis (AWS RDS, ElastiCache, etc.):**

```bash
# Pull the latest image
docker pull ghcr.io/cruxgarden/api:latest

# Run with your external services
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@your-db-host:5432/db" \
  -e REDIS_URL="redis://your-redis-host:6379" \
  -e JWT_SECRET="your-secret-key" \
  -e AWS_ACCESS_KEY_ID="your-key" \
  -e AWS_SECRET_ACCESS_KEY="your-secret" \
  -e AWS_REGION="us-east-1" \
  -e FROM_EMAIL_ADDRESS="noreply@yourdomain.com" \
  ghcr.io/cruxgarden/api:latest
```

Or use an `.env` file:

```bash
docker run -p 3000:3000 --env-file .env.production ghcr.io/cruxgarden/api:latest
```

**When to use this:**

- Production deployments with managed databases
- Kubernetes/cloud environments
- When you want to manage database/Redis separately

### Option 3: Build Locally (For Contributors)

**If you're making changes to the Docker setup:**

```bash
# Build the image from source
docker build -f docker/Dockerfile -t cruxgarden-api .

# Run with bundled services
cd docker
docker-compose up -d --build
```

The `--build` flag rebuilds the image with your local changes.

---

**For open source contributors: Use Option 1** (`docker-compose up -d`) for the easiest setup!

**For detailed Docker documentation:**

- [Comprehensive Deployment Guide](docker/DOCKER.md) - Production setup, security, troubleshooting
- [Quick Reference](docker/DOCKER_QUICKSTART.md) - Common commands and one-liners

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
