# Docker Quick Start

## For Production (External Database & Redis)

### 1. Pull the Image

```bash
docker pull ghcr.io/cruxgarden/api:latest
```

### 2. Set Environment Variables

Create a `.env.production` file:

```bash
DATABASE_URL=postgresql://user:pass@your-db-host:5432/cruxgarden
REDIS_URL=redis://your-redis-host:6379
JWT_SECRET=your-super-secret-jwt-key-minimum-32-characters
AWS_ACCESS_KEY_ID=your-aws-key
AWS_SECRET_ACCESS_KEY=your-aws-secret
AWS_REGION=us-east-1
FROM_EMAIL_ADDRESS=noreply@yourdomain.com
CORS_ORIGIN=https://yourdomain.com
```

### 3. Run Database Migrations

```bash
# Option 1: From your local machine (with knex installed)
DATABASE_URL="your-db-url" npx knex migrate:latest --env production

# Option 2: Using a temporary container
docker run --rm \
  -e DATABASE_URL="your-db-url" \
  ghcr.io/cruxgarden/api:latest \
  npx knex migrate:latest --env production
```

### 4. Start the Container

**Using docker run:**

```bash
docker run -d \
  --name cruxgarden-api \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env.production \
  ghcr.io/cruxgarden/api:latest
```

**Using docker-compose:**

```bash
# Use the production compose file
docker-compose -f docker-compose.prod.yml up -d
```

### 5. Verify It's Running

```bash
# Check health
curl http://localhost:3000/

# View logs
docker logs -f cruxgarden-api

# Check health status
docker inspect --format='{{.State.Health.Status}}' cruxgarden-api
```

## For Development (Bundled Services)

Use the standard `docker-compose.yml` which includes PostgreSQL and Redis:

```bash
# Start everything
docker-compose up -d

# View logs
docker-compose logs -f

# Stop everything
docker-compose down
```

## Common Commands

```bash
# View container logs
docker logs -f cruxgarden-api

# Execute command in container
docker exec cruxgarden-api npx knex migrate:status --env production

# Restart container
docker restart cruxgarden-api

# Stop and remove container
docker stop cruxgarden-api && docker rm cruxgarden-api

# Pull latest image
docker pull ghcr.io/cruxgarden/api:latest
```

## Environment Variables Reference

**Required:**
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `JWT_SECRET` - JWT signing secret (min 32 chars)
- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `AWS_REGION` - AWS region (e.g., us-east-1)
- `FROM_EMAIL_ADDRESS` - Email sender address

**Optional:**
- `CORS_ORIGIN` - Allowed origins (default: `*`)
- `LOG_LEVEL` - Logging level (default: `info`)
- `PORT` - Server port (default: `3000`)

## Troubleshooting

### Can't connect to database

```bash
# Test database connection from container
docker exec cruxgarden-api node -e "
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(() => { console.log('✓ Connected'); client.end(); })
  .catch(err => { console.error('✗ Error:', err.message); });
"
```

### Can't connect to Redis

```bash
# Test Redis connection from container
docker exec cruxgarden-api node -e "
const redis = require('redis');
const client = redis.createClient({ url: process.env.REDIS_URL });
client.connect()
  .then(() => { console.log('✓ Connected'); client.quit(); })
  .catch(err => { console.error('✗ Error:', err.message); });
"
```

### View detailed logs

```bash
# With timestamps
docker logs -t cruxgarden-api

# Follow logs
docker logs -f cruxgarden-api

# Last 100 lines
docker logs --tail 100 cruxgarden-api
```

## More Information

See [DOCKER.md](./DOCKER.md) for comprehensive documentation.
