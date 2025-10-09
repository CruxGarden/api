#!/bin/sh
set -e

#echo "Running database migrations and seeds..."
#npm run migrate:prod

echo "Starting application..."
exec node dist/src/main.js
