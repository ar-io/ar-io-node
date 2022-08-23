# Arweave Envoy Proxy

A simple Dockerized Envoy config for proxying requests to Arweave nodes.

## Development

Testing the templating script:

```
docker build . -t arweave-envoy-proxy:latest
docker run -it -e ARIO_HOST="localhost" -e ARIO_POST="3000" -e ARWEAVE_GATEWAY="arweave.dev" arweave-envoy-proxy:latest
```