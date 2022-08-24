#!/usr/bin/env sh

# Migrate the DB to the latest version
node dist/migrate.js up

# Run the gateway service
exec node dist/app.js
