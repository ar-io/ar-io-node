# AR.IO Envoy Proxy

A simple Dockerized Envoy config for proxying requests to AR.IO gateway
services and Arweave nodes.

## Development

You can run Envoy next to an existing gateway via Docker:

```shell
docker build . -t ar-io-envoy:latest
docker run -it -p 3000:3000 -p 9901:9901 -e AR_IO_HOST="localhost" -e AR_IO_PORT="4000" -e ARWEAVE_GATEWAY="arweave.dev" -e LOG_LEVEL="info" ar-io-envoy:latest
```
