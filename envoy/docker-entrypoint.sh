#!/usr/bin/env sh

# This is a copy of docker-entrypoint.sh from the official Envoy Docker image
# with code added to apply templating to the Envoy config file.

set -e

loglevel="${LOG_LEVEL:-}"
USERID=$(id -u)

# Update env vars
ytt --data-values-env TVAL -f /etc/envoy/envoy.template.yaml >  /etc/envoy/envoy.yaml
chmod go+r /etc/envoy/envoy.yaml

# Seed EDS files so Envoy can start before core classifies peers
if [ "${TVAL_ENABLE_ARWEAVE_PEER_EDS}" = "true" ]; then
    mkdir -p /data/envoy-eds

    # Seed full_nodes with trusted node so Envoy has an upstream at startup
    TRUSTED_HOST="${TVAL_TRUSTED_NODE_HOST:-arweave.net}"
    TRUSTED_PORT="${TVAL_TRUSTED_NODE_PORT:-443}"
    cat > /data/envoy-eds/arweave_full_nodes.json <<EDSEOF
{
  "version_info": "seed",
  "resources": [{
    "@type": "type.googleapis.com/envoy.config.endpoint.v3.ClusterLoadAssignment",
    "cluster_name": "arweave_full_nodes",
    "endpoints": [{
      "lb_endpoints": [{
        "endpoint": {
          "address": {
            "socket_address": { "address": "${TRUSTED_HOST}", "port_value": ${TRUSTED_PORT} }
          }
        },
        "health_status": "HEALTHY"
      }]
    }]
  }]
}
EDSEOF

    # Seed partial_nodes with empty endpoints
    cat > /data/envoy-eds/arweave_partial_nodes.json <<EDSEOF
{
  "version_info": "seed",
  "resources": [{
    "@type": "type.googleapis.com/envoy.config.endpoint.v3.ClusterLoadAssignment",
    "cluster_name": "arweave_partial_nodes",
    "endpoints": [{
      "lb_endpoints": []
    }]
  }]
}
EDSEOF

    chmod -R go+r /data/envoy-eds
fi

# if the first argument look like a parameter (i.e. start with '-'), run Envoy
if [ "${1#-}" != "$1" ]; then
    set -- envoy "$@"
fi

if [ "$1" = 'envoy' ]; then
    # set the log level if the $loglevel variable is set
    if [ -n "$loglevel" ]; then
        set -- "$@" --log-level "$loglevel"
    fi
fi

if [ "$ENVOY_UID" != "0" ] && [ "$USERID" = 0 ]; then
    if [ -n "$ENVOY_UID" ]; then
        usermod -u "$ENVOY_UID" envoy
    fi
    if [ -n "$ENVOY_GID" ]; then
        groupmod -g "$ENVOY_GID" envoy
    fi
    # Ensure the envoy user is able to write to container logs
    chown envoy:envoy /dev/stdout /dev/stderr
    exec su-exec envoy "${@}"
else
    exec "${@}"
fi
