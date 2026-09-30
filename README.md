<div align="center">
  <img src=".github/banner.jpg" alt="Crux Garden API — grow anything" width="100%">
</div>

# Crux Garden API

**grow anything** — the service behind a local-first creative workspace.

Crux Garden lets people make things with or without AI, keep their history, and publish
when ready. A **Crux** is a creative project; **Artifacts** are its files; **Growth** is
its version history. Gardens organize related Cruxes.

This repository contains the NestJS API and the packaged local runtime used by the
[desktop app](https://github.com/CruxGarden/app). The hosted API owns account authentication,
sync, publication, and server-side Crux Store/Function access. The local runtime owns the
desktop SQLite database and content manifests. Provider credentials belong to the configured
AI integration; this service is not an AI proxy.

The HTTP service uses PostgreSQL, Knex, and Redis. Hosted authentication and publication
need the corresponding deployment configuration; development email/storage mocks do not
prove live delivery. See `.env.example`, `CONTRIBUTING.md`, and `SECURITY.md`.

## Getting Started

### Prerequisites

- Node.js 22 (see `.nvmrc`)
- Docker (recommended) or PostgreSQL and Redis

### Quick Start

Copy the environment template:

```bash
cp .env.example .env
```

Edit `.env` and set your `JWT_SECRET` (minimum 32 characters). Other variables have sensible defaults or will run in mock mode.

### Option 1: With Docker (Recommended)

```bash
npm run setup  # Install dependencies, start Docker containers, run migrations
npm run dev    # Start development server
```

### Option 2: Without Docker

Using your own PostgreSQL and Redis:

```bash
# Update .env with your database and Redis URLs:
# DATABASE_URL=postgresql://user:password@localhost:5432/cruxgarden
# REDIS_URL=redis://localhost:6379

npm ci              # Install dependencies
npm run migrate:dev # Run migrations
npm run start:dev   # Start development server
```

The API will be available at `http://localhost:3000`. Visit `http://localhost:3000/docs` for interactive API documentation.

## Running Tests

The suite includes real SQLite file, archive and restart workflows. Jest uses two workers and a 30-second default budget for these operations; tests of runtime deadlines keep their explicit limits. Integration tests run serially.

`npm run verify` is the release gate: lint, unit tests, HTTP integration tests, build, and the packaged local-runtime smoke check. The integration gate requires a running Docker engine. Its PostgreSQL fixture starts a disposable `postgres:16-alpine` container on a random loopback port, applies the real migrations, and removes the container afterward. It never reads database credentials from `.env` or connects to an existing database. The image is downloaded on first use if it is absent. No Redis server is needed for these fixtures.

```bash
npm run test             # Unit tests
npm run test:integration # Integration tests
npm run test:all         # All tests
```

## Environment Variables

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
