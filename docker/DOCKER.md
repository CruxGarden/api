# Docker Deployment Guide

This guide explains how to use the two Docker environments for Crux Garden API: **Development** and **Production**.

## Overview

Crux Garden provides two distinct Docker environments, each optimized for different use cases:

| Environment     | Purpose                      | Image Source    | Database/Redis                   | Data Seeds                  |
|-----------------|------------------------------|-----------------|----------------------------------|-----------------------------|
| **Development** | Local development            | Local build     | Bundled (PostgreSQL + Redis)     | Common only                 |
| **Production**  | Live deployment              | Published image | External (bring your own)        | Common + System data        |

## Common Features

All environments share these characteristics:

- **Separate Migration Service**: Migrations run in a dedicated, ephemeral container that must complete successfully before the API starts
- **Health Checks**: PostgreSQL, Redis, and API all have health checks with proper retry logic
- **Signal Handling**: Uses `dumb-init` for proper signal propagation
- **Non-root User**: Runs as user `nestjs` (UID 1001)
- **Consistent Environment Variables**: All environments use the same env var structure

---

## Development Environment

### Purpose

Local development with rapid iteration. Builds the Docker image from your local codebase and includes PostgreSQL and Redis containers.

### Architecture

```text
┌─────────────┐
│  Postgres   │
│  (bundled)  │
└──────┬──────┘
       │
┌──────▼──────────┐
│   Migrations    │ (ephemeral)
│  (local build)  │
└──────┬──────────┘
       │
┌──────▼──────────┐     ┌─────────────┐
│      API        │────▶│    Redis    │
│  (local build)  │     │  (bundled)  │
└─────────────────┘     └─────────────┘
```

### Quick Start

```bash
# Start all services (postgres, redis, migrations, api)
npm run docker:dev

# API will be running at http://localhost:3000
# PostgreSQL on localhost:5432
# Redis on localhost:6379

# View API logs
npm run docker:dev:logs

# Stop all services
npm run docker:dev:down

# Rebuild API after code changes
npm run docker:dev:rebuild

# Complete fresh reset (wipes database!)
npm run docker:dev:reset
```

### Environment Variables

Development uses sensible defaults from `.env.example`. Required variables:

```bash
# .env (minimal for dev)
JWT_SECRET=your-super-secret-jwt-key-min-32-chars-for-development-only

# Optional (defaults provided)
DATABASE_URL=postgresql://cruxgarden:cruxgarden_dev_password@postgres:5432/cruxgarden
REDIS_URL=redis://redis:6379
AWS_ACCESS_KEY_ID=your-key-id
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=us-east-1
FROM_EMAIL_ADDRESS=noreply@example.com
```

### Data Seeds

Development runs **common seeds only**:

- `db/seeds/common/01_keeper_account.ts` - System account (The Keeper)
- `db/seeds/common/02_themes.ts` - Default themes

---

## Production Environment

### Purpose

Live production deployment. Uses the published Docker image and **requires external database and Redis** (managed services like AWS RDS, ElastiCache, or your own infrastructure).

### Architecture

```text
┌──────────────────┐
│  External        │
│  PostgreSQL      │
│  (RDS, etc.)     │
└──────┬───────────┘
       │
┌──────▼──────────┐
│   Migrations    │ (ephemeral)
│ (published img) │
└──────┬──────────┘
       │
┌──────▼──────────┐     ┌──────────────────┐
│      API        │────▶│  External Redis  │
│ (published img) │     │ (ElastiCache)    │
└─────────────────┘     └──────────────────┘
```

### Deployment

Production deployments are typically orchestrated by your hosting platform (AWS ECS, Kubernetes, etc.), but you can test locally:

```bash
# Set required environment variables
export DATABASE_URL=postgresql://user:pass@your-db-host:5432/cruxgarden
export REDIS_URL=redis://your-redis-host:6379
export JWT_SECRET=your-production-secret-min-32-chars
export AWS_ACCESS_KEY_ID=your-aws-key
export AWS_SECRET_ACCESS_KEY=your-aws-secret
export FROM_EMAIL_ADDRESS=noreply@cruxgarden.com

# Pull and start (from docker/ directory)
cd docker
docker-compose --env-file ../.env -f docker-compose.prod.yml up -d
```

### Environment Variables

Production requires **all variables** to be set (no defaults):

```bash
# Required Application Settings
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0

# Required External Services
DATABASE_URL=postgresql://user:pass@your-db-host:5432/cruxgarden
REDIS_URL=redis://your-redis-host:6379

# Required Security
JWT_SECRET=your-production-secret-min-32-chars-use-strong-random

# Required AWS SES
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
FROM_EMAIL_ADDRESS=noreply@cruxgarden.com

# Optional Configuration
CORS_ORIGIN=https://cruxgarden.com
LOG_LEVEL=info
DB_POOL_MIN=2
DB_POOL_MAX=10
DB_POOL_IDLE_TIMEOUT=30000
DB_POOL_ACQUIRE_TIMEOUT=60000
RATE_LIMIT_TTL=60000
RATE_LIMIT_MAX=100
```

### Data Seeds

Production runs **common + production seeds**:

- `db/seeds/common/01_keeper_account.ts` - System account
- `db/seeds/common/02_themes.ts` - Default themes
- `db/seeds/production/01_system_cruxes.ts` - System messages (Welcome, ToS, etc.)

### Published Image

The production image is built and published via GitHub Actions:

```bash
# Published to GitHub Container Registry
ghcr.io/cruxgarden/api:latest
ghcr.io/cruxgarden/api:v0.0.1  # Version tags
```

---

## Command Reference

### Development Commands

```bash
# Start/Stop
npm run docker:dev              # Start all services
npm run docker:dev:down         # Stop all services
npm run docker:dev:logs         # View API logs

# Building/Resetting
npm run docker:dev:rebuild      # Rebuild API from local source
npm run docker:dev:reset        # Complete fresh reset (⚠️ wipes database!)

# Database Management
npm run docker:dev:db           # Start only postgres + redis
npm run docker:dev:db:stop      # Stop postgres + redis
```

### Database/Redis Commands

```bash
npm run docker:db:connect       # Connect to PostgreSQL (psql)
npm run docker:redis:connect    # Connect to Redis (redis-cli)
npm run docker:api:connect      # Shell into API container (sh)
```

### Manual Docker Compose Commands

If you prefer to use docker-compose directly:

```bash
# Development
cd docker
docker-compose --env-file ../.env -f docker-compose.dev.yml up -d
docker-compose --env-file ../.env -f docker-compose.dev.yml down
docker-compose --env-file ../.env -f docker-compose.dev.yml logs -f api

# Production
cd docker
docker-compose --env-file ../.env -f docker-compose.prod.yml up -d
```

---

## Migration Strategy

All environments use a **dedicated migration service** that runs before the API starts:

1. **Migrations Service Starts**: Ephemeral container runs migrations and seeds
2. **Migrations Complete**: Container exits with success
3. **API Service Starts**: Only starts if migrations completed successfully
4. **API Ready**: Serves traffic

### Migration Commands

Each environment uses a different npm script:

```bash
# Development (common seeds only)
npm run migrate:seed
# → knex migrate:latest --env development
# → knex seed:run --env development

# Production (common + production seeds)
npm run migrate:prod
# → knex migrate:latest --env production
# → knex seed:run --env production

# Nursery (common + nursery seeds)
npm run migrate:nursery
# → knex migrate:latest --env nursery
# → knex seed:run --env nursery
```

### Troubleshooting Migrations

If migrations fail:

```bash
# View migration container logs
docker logs cruxgarden-migrations

# Check migration status locally
npm run migrate:status
```

---

## Cleanup

### Stop and Remove Containers

```bash
# Development
npm run docker:dev:down

# Manual cleanup with volumes (⚠️ deletes data)
cd docker
docker-compose --env-file ../.env -f docker-compose.dev.yml down -v
```

### Complete Reset (Fresh Start)

For a complete fresh start with database wiped:

```bash
# Dev: Stop everything, delete volumes, rebuild from source
npm run docker:dev:reset
```

⚠️ **Warning**: Reset commands delete all volumes, including database data!

---

## Ports

Port mappings for each environment:

| Service    | Dev Port | Notes                              |
|------------|----------|-------------------------------------|
| API        | 3000     | Main API endpoint                   |
| PostgreSQL | 5432     | Bundled in dev only                 |
| Redis      | 6379     | Bundled in dev only                 |

**Production** uses external DATABASE_URL and REDIS_URL (no local ports).

---

## Health Checks

All services include health checks:

- **PostgreSQL**: `pg_isready` every 5s (5 retries)
- **Redis**: `redis-cli ping` every 5s (5 retries)
- **API**: HTTP GET to `/` every 30s (3 retries, 40s start period)

---

## Seed Data Strategy

### Common Seeds (`db/seeds/common/`)

**Always run in all environments**

- System-critical data the application depends on
- Default themes, system accounts, etc.

### Production Seeds (`db/seeds/production/`)

**Run in production only**

- System messages (ToS, Privacy Policy, Welcome)
- Production-specific configuration

### Nursery Seeds (`db/seeds/nursery/`)

**Run in nursery only**

- Demo/sample data for trials and showcases
- Example cruxes, relationships, etc.

---

## Best Practices

### Development

- Use `npm run docker:dev:rebuild` after changing dependencies or Dockerfile
- Use `npm run docker:dev:logs` to debug issues
- Keep `.env` out of version control
- Use `docker:dev:reset` for a clean slate when troubleshooting

### Nursery

- Update demo seeds regularly to showcase latest features
- Keep nursery data realistic but anonymized
- Test nursery environment before major releases
- Use nursery for QA, demos, and stakeholder reviews

### Production

- Use managed database services (AWS RDS, etc.)
- Use managed Redis (AWS ElastiCache, etc.)
- Store secrets in environment variables or secrets manager
- Monitor logs and health checks
- Set up backup and recovery procedures
- Use specific version tags, not `:latest`
- Never expose database/Redis ports publicly

---

## Environment Variable Reference

Complete list of supported environment variables:

```bash
# Application
NODE_ENV=production                 # Always "production" in Docker
PORT=3000                           # API port
HOSTNAME=0.0.0.0                    # Bind address

# External Services
DATABASE_URL=postgresql://...       # PostgreSQL connection string
REDIS_URL=redis://...               # Redis connection string

# Security
JWT_SECRET=...                      # Min 32 chars, use strong random value

# AWS SES (Email)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
FROM_EMAIL_ADDRESS=...

# Optional: CORS
CORS_ORIGIN=*                       # Allowed origins (comma-separated)

# Optional: Logging
LOG_LEVEL=info                      # debug, info, warn, error

# Optional: Database Pool
DB_POOL_MIN=2
DB_POOL_MAX=10
DB_POOL_IDLE_TIMEOUT=30000
DB_POOL_ACQUIRE_TIMEOUT=60000

# Optional: Rate Limiting
RATE_LIMIT_TTL=60000                # Time window in ms
RATE_LIMIT_MAX=100                  # Max requests per window
```

---

## Troubleshooting

### Container won't start

```bash
# Check logs
npm run docker:dev:logs
# or
docker logs cruxgarden-api

# Check all container statuses
docker ps -a --filter 'name=cruxgarden'
```

### Database connection errors

```bash
# Verify postgres is running
docker ps --filter 'name=cruxgarden-postgres'

# Check postgres logs
docker logs cruxgarden-postgres

# Test connection
npm run docker:db:connect
```

### Migration failures

```bash
# View migration logs
docker logs cruxgarden-migrations

# Check database status
npm run migrate:status

# Reset and try again
npm run docker:dev:reset
```

### Port conflicts

If ports 3000, 5432, or 6379 are already in use:

```bash
# Find what's using the port
lsof -i :3000
lsof -i :5432
lsof -i :6379

# Stop the conflicting service or change ports in docker-compose
```

---

## Support

For issues or questions:

- [GitHub Issues](https://github.com/CruxGarden/api/issues)
- [Documentation](https://github.com/CruxGarden/api#readme)
