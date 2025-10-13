<div align="center">
  <img src=".github/banner.jpg" alt="Crux Garden - Where Ideas Grow" width="100%">
</div>

## What is Crux Garden?

Crux Garden is a model of how ideas manifest and develop over time. The heart of the model is the **Crux**, an atomic representation of an idea. In our implementation, a Crux can be text, media, code, or any digital content worth preserving. But Cruxes, just like ideas, don't exist in isolation. Ideas have origins. They lead to new ideas. They evolve. And often, they randomly connect. So it is with Cruxes. In Crux Garden, there are four types of relationships Cruxes can have with each other. These are called **Dimensions**:

- **GATES** — Cruxes which influenced or inspired a Crux; its origins and sources.
- **GARDENS** — Cruxes which emerged or grew from a Crux, its creations and consequences.
- **GROWTH** — Cruxes which capture how a Crux developed over time, its transformation and refinement.
- **GRAFTS** — Cruxes which connect to a Crux laterally, its associations and resonances.

These four Dimensions capture the fundamental ways that Cruxes, or ideas, relate to one another.

The power of a system that models ideas at such a primitive scale is that literally any idea or framework of ideas can be realized inside Crux Garden.

Along with Cruxes and Dimensions, there are several other types including Tags, Themes, and Paths. See the database schema in `db/schema.sql` or the API documentation at `/docs` for details.

For further reading on the goals and ambitions of Crux Garden, explore the history of the [Digital Garden](https://maggieappleton.com/garden-history) movement and the 1945 essay [As We May Think](https://en.wikipedia.org/wiki/As_We_May_Think) by Vannevar Bush.

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
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
- `AWS_S3_ATTACHMENTS_BUCKET` - S3 bucket for file storage

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

This project is licensed under the Apache 2.0 License - see the [LICENSE](LICENSE) file for details.
