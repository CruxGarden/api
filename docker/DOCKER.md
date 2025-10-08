# Docker Deployment Guide

This guide covers deploying the Crux Garden API using Docker with external PostgreSQL and Redis services.

## Prerequisites

- Docker 20.10+ and Docker Compose 2.0+
- External PostgreSQL database (version 14+)
- External Redis instance (version 6+)
- Required environment variables (see below)

## Quick Start

### 1. Using Pre-built Image from GitHub Container Registry

```bash
# Pull the latest image
docker pull ghcr.io/cruxgarden/api:latest

# Run with external DATABASE_URL and REDIS_URL
docker run -d \
  --name cruxgarden-api \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:password@your-db-host:5432/cruxgarden" \
  -e REDIS_URL="redis://your-redis-host:6379" \
  -e JWT_SECRET="your-super-secret-jwt-key-minimum-32-characters" \
  -e AWS_ACCESS_KEY_ID="your-aws-key" \
  -e AWS_SECRET_ACCESS_KEY="your-aws-secret" \
  -e AWS_REGION="us-east-1" \
  -e FROM_EMAIL_ADDRESS="noreply@yourdomain.com" \
  ghcr.io/cruxgarden/api:latest
```

### 2. Building Locally

```bash
# Build the image from project root
docker build -f docker/Dockerfile -t cruxgarden-api .

# Run the container
docker run -d \
  --name cruxgarden-api \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:password@your-db-host:5432/cruxgarden" \
  -e REDIS_URL="redis://your-redis-host:6379" \
  -e JWT_SECRET="your-jwt-secret" \
  -e AWS_ACCESS_KEY_ID="your-aws-key" \
  -e AWS_SECRET_ACCESS_KEY="your-aws-secret" \
  -e AWS_REGION="us-east-1" \
  -e FROM_EMAIL_ADDRESS="noreply@yourdomain.com" \
  cruxgarden-api
```

### 3. Using Docker Compose (with bundled Postgres/Redis for development)

```bash
# From project root
cd docker

# Start all services (API + PostgreSQL + Redis)
docker-compose up -d

# View logs
docker-compose logs -f api

# Stop all services
docker-compose down

# Remove volumes (delete all data)
docker-compose down -v
```

## Required Environment Variables

When deploying with external services, you must provide:

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `REDIS_URL` | Redis connection string | `redis://host:6379` |
| `JWT_SECRET` | Secret for JWT tokens (min 32 chars) | `your-secret-key-here` |
| `AWS_ACCESS_KEY_ID` | AWS access key for SES | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| `AWS_REGION` | AWS region for SES | `us-east-1` |
| `FROM_EMAIL_ADDRESS` | Sender email address | `noreply@yourdomain.com` |

## Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Environment mode |
| `PORT` | `3000` | Server port |
| `HOSTNAME` | `0.0.0.0` | Server hostname |
| `LOG_LEVEL` | `info` | Logging level |
| `CORS_ORIGIN` | `*` | Allowed CORS origins |
| `DB_POOL_MIN` | `2` | Min database connections |
| `DB_POOL_MAX` | `10` | Max database connections |
| `RATE_LIMIT_TTL` | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |

## Database Setup

Before running the API, ensure your database is initialized:

```bash
# Run migrations (from host machine with knex installed)
DATABASE_URL="postgresql://user:pass@host:5432/db" npx knex migrate:latest --env production

# Or run migrations inside container
docker exec cruxgarden-api npx knex migrate:latest --env production
```

## Production Deployment

### Using Docker with External Services

**Example: Deploy to a cloud provider with managed Postgres and Redis**

```bash
# Create .env.production file
cat > .env.production << 'EOF'
DATABASE_URL=postgresql://user:password@production-db.example.com:5432/cruxgarden
REDIS_URL=redis://production-redis.example.com:6379
JWT_SECRET=your-production-jwt-secret-minimum-32-characters
AWS_ACCESS_KEY_ID=your-production-aws-key
AWS_SECRET_ACCESS_KEY=your-production-aws-secret
AWS_REGION=us-east-1
FROM_EMAIL_ADDRESS=noreply@yourdomain.com
CORS_ORIGIN=https://yourdomain.com,https://app.yourdomain.com
LOG_LEVEL=warn
EOF

# Run container with production config
docker run -d \
  --name cruxgarden-api \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env.production \
  ghcr.io/cruxgarden/api:latest
```

### Using Docker Compose with External Services

Create a `docker-compose.prod.yml`:

```yaml
version: '3.8'

services:
  api:
    image: ghcr.io/cruxgarden/api:latest
    container_name: cruxgarden-api
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      JWT_SECRET: ${JWT_SECRET}
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      AWS_REGION: ${AWS_REGION}
      FROM_EMAIL_ADDRESS: ${FROM_EMAIL_ADDRESS}
      CORS_ORIGIN: ${CORS_ORIGIN}
      LOG_LEVEL: warn
```

Then run:

```bash
docker-compose -f docker-compose.prod.yml up -d
```

## Health Checks

The container includes a built-in health check that verifies the API is responding:

```bash
# Check container health
docker inspect --format='{{.State.Health.Status}}' cruxgarden-api

# View health check logs
docker inspect --format='{{json .State.Health}}' cruxgarden-api | jq
```

The health check endpoint is the root path `/` and expects a 200 status code.

## Image Details

### Multi-stage Build

The Dockerfile uses a multi-stage build for optimal size and security:

1. **Builder stage**: Installs all dependencies and builds TypeScript
2. **Production stage**: Copies only production dependencies and built code

### Security Features

- Runs as non-root user (`nestjs:nodejs`)
- Uses Alpine Linux for minimal attack surface
- Includes `dumb-init` for proper signal handling
- Production dependencies only in final image

### Image Size

Approximate image size: ~350MB (including Node.js runtime and dependencies)

## Troubleshooting

### Container won't start

```bash
# View container logs
docker logs cruxgarden-api

# Check environment variables
docker exec cruxgarden-api env | grep -E "DATABASE_URL|REDIS_URL"
```

### Database connection issues

```bash
# Test database connectivity from container
docker exec cruxgarden-api node -e "
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(() => { console.log('✓ Database connected'); client.end(); })
  .catch(err => { console.error('✗ Database error:', err.message); process.exit(1); });
"
```

### Redis connection issues

```bash
# Test Redis connectivity from container
docker exec cruxgarden-api node -e "
const redis = require('redis');
const client = redis.createClient({ url: process.env.REDIS_URL });
client.connect()
  .then(() => { console.log('✓ Redis connected'); client.quit(); })
  .catch(err => { console.error('✗ Redis error:', err.message); process.exit(1); });
"
```

### View application logs

```bash
# Follow logs in real-time
docker logs -f cruxgarden-api

# View last 100 lines
docker logs --tail 100 cruxgarden-api

# View logs with timestamps
docker logs -t cruxgarden-api
```

## Development vs Production

### Development (docker-compose.yml)

- Includes PostgreSQL and Redis containers
- Uses default/development credentials
- Suitable for local testing
- Data persisted in Docker volumes

### Production (external services)

- Requires external PostgreSQL and Redis
- Uses production credentials via environment variables
- Suitable for production deployment
- Managed database backups and high availability

## GitHub Container Registry

Images are automatically built and published to GitHub Container Registry on every push to `main`:

```bash
# Pull latest
docker pull ghcr.io/cruxgarden/api:latest

# Pull specific version
docker pull ghcr.io/cruxgarden/api:0.0.1

# Pull specific commit
docker pull ghcr.io/cruxgarden/api:main-abc1234
```

## Next Steps

1. Set up your external PostgreSQL and Redis instances
2. Configure environment variables
3. Run database migrations
4. Deploy the container
5. Set up reverse proxy (nginx, Traefik, etc.) for HTTPS
6. Configure monitoring and logging
7. Set up automated backups for your database

## Support

For issues and questions:
- GitHub Issues: https://github.com/CruxGarden/api/issues
- Documentation: https://github.com/CruxGarden/api#readme
