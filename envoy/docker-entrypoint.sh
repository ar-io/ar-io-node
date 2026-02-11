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

    PEER_DNS_RECORDS="${TVAL_ARWEAVE_PEER_DNS_RECORDS:-peers.arweave.xyz}"
    PEER_PORT="${TVAL_ARWEAVE_PEER_DNS_PORT:-1984}"

    # Validate existing EDS files - remove corrupt files so they get re-seeded
    for EDS_FILE in /data/envoy-eds/arweave_full_nodes.json /data/envoy-eds/arweave_partial_nodes.json; do
        if [ -f "${EDS_FILE}" ]; then
            if ! jq -e '.resources[0].cluster_name' "${EDS_FILE}" > /dev/null 2>&1; then
                echo "Removing corrupt EDS file: ${EDS_FILE}"
                rm -f "${EDS_FILE}"
            fi
        fi
    done

    # Resolve first DNS record to seed EDS with real peer IPs
    FIRST_RECORD=$(echo "${PEER_DNS_RECORDS}" | cut -d',' -f1 | tr -d ' ')
    SEED_ENDPOINTS=""
    NEED_SEED=$([ ! -f /data/envoy-eds/arweave_full_nodes.json ] && echo "true" || echo "false")
    MAX_RETRIES=10
    RETRY_DELAY=5
    ATTEMPT=0

    while [ -n "${FIRST_RECORD}" ]; do
        SEED_IPS=$(getent ahostsv4 "${FIRST_RECORD}" 2>/dev/null | awk '{print $1}' | sort -u)
        FIRST=true
        SEED_ENDPOINTS=""
        for IP in ${SEED_IPS}; do
            if [ "${FIRST}" = "true" ]; then
                FIRST=false
            else
                SEED_ENDPOINTS="${SEED_ENDPOINTS},"
            fi
            SEED_ENDPOINTS="${SEED_ENDPOINTS}{\"endpoint\":{\"address\":{\"socket_address\":{\"address\":\"${IP}\",\"port_value\":${PEER_PORT}}}},\"health_status\":\"HEALTHY\"}"
        done

        if [ -n "${SEED_ENDPOINTS}" ]; then
            break
        fi

        ATTEMPT=$((ATTEMPT + 1))
        if [ "${NEED_SEED}" = "false" ] || [ "${ATTEMPT}" -ge "${MAX_RETRIES}" ]; then
            echo "DNS resolution failed (attempt ${ATTEMPT}), existing EDS file: ${NEED_SEED}, giving up"
            break
        fi

        echo "DNS resolution failed (attempt ${ATTEMPT}/${MAX_RETRIES}), retrying in ${RETRY_DELAY}s..."
        sleep "${RETRY_DELAY}"
    done

    if [ ! -f /data/envoy-eds/arweave_full_nodes.json ]; then
        cat > /data/envoy-eds/arweave_full_nodes.json <<EDSEOF
{
  "version_info": "seed",
  "resources": [{
    "@type": "type.googleapis.com/envoy.config.endpoint.v3.ClusterLoadAssignment",
    "cluster_name": "arweave_full_nodes",
    "endpoints": [{
      "lb_endpoints": [${SEED_ENDPOINTS}]
    }]
  }]
}
EDSEOF
    fi

    # Seed partial_nodes with empty endpoints
    if [ ! -f /data/envoy-eds/arweave_partial_nodes.json ]; then
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
    fi

    chmod -R a+rX /data/envoy-eds
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
