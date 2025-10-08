# Docker Configuration

This directory contains all Docker-related files for the Crux Garden API.

## Files

- **`Dockerfile`** - Production-ready multi-stage build
- **`docker-compose.yml`** - Development setup with bundled Postgres & Redis
- **`docker-compose.prod.yml`** - Production setup for external services
- **`.dockerignore`** - Build context optimization
- **`.env.production.example`** - Production environment template
- **`DOCKER.md`** - Comprehensive deployment guide
- **`DOCKER_QUICKSTART.md`** - Quick reference guide

## Quick Start

### For Local Development

```bash
# From the docker directory
cd docker
docker-compose up -d
```

### For Production

```bash
# From project root
docker build -f docker/Dockerfile -t cruxgarden-api .
docker run -d -p 3000:3000 --env-file .env.production cruxgarden-api
```

Or use the production compose file:

```bash
cd docker
docker-compose -f docker-compose.prod.yml up -d
```

## Documentation

- **[DOCKER_QUICKSTART.md](./DOCKER_QUICKSTART.md)** - Quick commands and common tasks
- **[DOCKER.md](./DOCKER.md)** - Full deployment guide with troubleshooting

## Requirements

- Docker 20.10+
- Docker Compose 2.0+
- External PostgreSQL (production)
- External Redis (production)

## Environment Variables

Required for production:
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `JWT_SECRET` - Min 32 characters
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
- `FROM_EMAIL_ADDRESS`

See `.env.production.example` for complete list.
