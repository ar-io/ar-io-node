#!/usr/bin/env sh

# Create DB directory if necessary
mkdir -p data/sqlite

# Migrate the DB to the latest version
/nodejs/bin/node dist/migrate.js up

if [ -z "$NODE_MAX_OLD_SPACE_SIZE" ]; then
  NODE_MAX_OLD_SPACE_SIZE=2048
fi

# Run the gateway service
exec /nodejs/bin/node --max-old-space-size=$NODE_MAX_OLD_SPACE_SIZE dist/app.js
