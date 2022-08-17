# Arweave Envoy Proxy

A simple Dockerized Envoy config for proxying requests to Arweave nodes.

## Development

Testing the templating script:

```
docker build . -t arweave-envoy-proxy:latest
docker run -it -e ARWEAVE_NODES="a:1" --entrypoint /generate_config.clj arweave-envoy-proxy:latest /etc/envoy/envoy.yaml.template
```

## Why Babashka?

Babashka (a version of Clojure) is used for templating because it is
distributed as a single self-contained static binary that is easy to include in
the container.