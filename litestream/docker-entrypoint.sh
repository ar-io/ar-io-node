#!/usr/bin/env sh

set -e

# Update env vars
ytt --data-values-env TVAL -f /etc/litestream.template.yaml >  /etc/litestream.yml
chmod go+r /etc/litestream.yml

/usr/local/bin/litestream replicate -config /etc/litestream.yml