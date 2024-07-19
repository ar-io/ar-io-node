#!/usr/bin/env sh

set -e

# Update env vars
ytt -f /etc/litestream.template.yaml --data-values-env TVAL >  /etc/litestream.yml

chmod go+r /etc/litestream.yml

if [ -n "$AR_IO_SQLITE_RESTORE_FROM_BACKUP" ]; then
  echo "Attempting to restore from backup if exists..."
  /usr/local/bin/litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists /app/data/sqlite/core.db
  /usr/local/bin/litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists /app/data/sqlite/data.db
  /usr/local/bin/litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists /app/data/sqlite/moderation.db
  /usr/local/bin/litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists /app/data/sqlite/bundles.db
fi

/usr/local/bin/litestream replicate -config /etc/litestream.yml
