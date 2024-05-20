#!/usr/bin/env sh

set -e

# Update env vars
ytt -f /etc/litestream.template.yaml --data-values-env TVAL >  /etc/litestream.yml

chmod go+r /etc/litestream.yml

/usr/local/bin/litestream replicate -config /etc/litestream.yml
