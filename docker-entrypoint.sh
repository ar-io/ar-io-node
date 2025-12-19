#!/usr/bin/env sh

# Create DB directory if necessary
mkdir -p data/sqlite

# Migrate the DB to the latest version
/nodejs/bin/node dist/migrate.js up

if [ -z "$NODE_MAX_OLD_SPACE_SIZE" ]; then
  # 8GB for > 1 workers, 2GB for <= 1 worker
  if [ "0$ANS104_UNBUNDLE_WORKERS" -gt "1" ]; then
    NODE_MAX_OLD_SPACE_SIZE=8192
  else
    NODE_MAX_OLD_SPACE_SIZE=2048
  fi
fi

# Run the gateway service
# Note: --import ./dist/tracing.js must come before app.js so Winston instrumentation
# is registered before the logger is created (enables trace ID correlation in logs)
exec /nodejs/bin/node --max-old-space-size=$NODE_MAX_OLD_SPACE_SIZE --import ./dist/tracing.js dist/app.js
