#!/usr/bin/env sh

# Create DB directory if necessary
mkdir -p data/sqlite

# Migrate the DB to the latest version
/nodejs/bin/node dist/migrate.js up

if [ -z "$NODE_MAX_OLD_SPACE_SIZE" ]; then
  # 8GB for > 1 workers, 2GB for <= 1 worker
  if [ "$ANS104_UNBUNDLE_WORKERS" -gt "1" ]; then
    NODE_MAX_OLD_SPACE_SIZE=8192
  else
    NODE_MAX_OLD_SPACE_SIZE=2048
  fi
fi

# Run the gateway service
exec /nodejs/bin/node --max-old-space-size=$NODE_MAX_OLD_SPACE_SIZE dist/app.js
