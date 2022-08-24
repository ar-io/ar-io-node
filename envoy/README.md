# Arweave Envoy Proxy

A simple Dockerized Envoy config for proxying requests to Arweave gateways.

## Development

You can run envoy next to an existing gateway via docker:

```shell
docker build . -t arweave-envoy-proxy:latest
docker run -it -p 1984:1984 -p 9901:9901 -e ARIO_HOST="localhost" -e ARIO_PORT="3000" -e ARWEAVE_GATEWAY="arweave.dev" -e LOG_LEVEL="info" arweave-envoy-proxy:latest
```
