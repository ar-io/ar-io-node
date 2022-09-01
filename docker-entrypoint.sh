#!/usr/bin/env sh

# Create DB directory if necessary
mkdir -p data/sqlite

# Migrate the DB to the latest version
node dist/migrate.js up

# Run the gateway service
exec node dist/app.js
