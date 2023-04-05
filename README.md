# AR.IO Gateway Node

## Dev Workflow

### Install dependencies

`yarn install`

### Initialize the SQLite DB

`yarn db:migrate up`

### Run tests

`yarn test`

### Run the service

With defaults:

`yarn start`

Starting at an arbitrary block (only works immediately after initial DB
migration):

`START_HEIGHT=800000 yarn start`

## Docker

### Standalone AR.IO Node

You can run the ar.io gateway as a standalone docker container:

```shell
docker build . -t ar-io-core:latest
docker run -p 4000:4000 -v ar-io-data:/app/data ar-io-core:latest
```

To run with a specified start height (sets height on first run only):

```shell
docker run -e START_HEIGHT=800000 -v $PWD/data/:/app/data ar-io-core:latest
```

### Envoy & AR.IO Node

You can also run [Envoy] along side an `ar.io` node via [Docker Compose]. Envoy
will proxy routes to `arweave.net` not yet implemented in the ar.io node.

```shell
docker compose up --build
```

or:

```shell
docker-compose up --build
```

Once running, requests can be directed to Envoy server at `localhost:3000`.

## Configuration

When running via docker-compose, it will read a `.env` file in the project root
directory and use the envrionment variables set there.

### GraphQL Pass-Through

Add the following to your `.env` file to proxy GraphQL to another server while
using the ar.io gateway to serve data (using arweave.net GraphQL as an example):

```
GRAPHQL_HOST=arweave.net
GRAPHQL_PORT=443
```

### ArNS

Add the following to your `.env` file to enable ArNS resolution:

```
ARNS_ROOT_HOST=<gateway-hostname>
```

For example if your gateway's hostname was `my-gateway.net` your `.env` would
contain the following:

```
ARNS_ROOT_HOST=my-gateway.net
```

This would allow you to resolve names like `my-arns-name.my-gateway.net` provided
you correctly configured a wildcard DNS entry for your gateway.

Note: ArNS data ID resolution is currently delegated to `arweave.dev`. Routing is
handled locally, but ArNS state is not yet computed locally. Local ArNS state
computation will be added in a future release. Also, be aware, ArNS is still using
a test contract. Resolved names should be considered temporary.

### Wallet assocation

In order to participate in the ar.io network, gateways need to advertise their wallet
association. This can be configured by setting the AR_IO_WALLET environment variable.
Once set, the associated wallet address is visible via the `/ar-io/info` endpoint.

### Admin API key

HTTP endpoints under '/ar-io/admin' are protected by an admin API key. On startup,
the admin key is read from the `ADMIN_API_KEY` environment variable. If no key is
set, a random key is generated and logged. To make a request to an admin endpoint
add an `Authorization: Bearer <ADMIN_API_KEY>` header to your request.

## Principles and Practices

### Architecture

- Code to interfaces.
- Separate IO from application logic.
- Make processes [idempotent] whenever possible.
- Separate mutable from immutable data.
- Avoid trusting data when the cost to validate it is low.

### Development and Testing

- To support rapid development iteration, All system components _must_ be
  runnable in a single process.
- Keep the [compile test suite] blazingly fast.
- In general, prefer in-memory implementations over mocks and stubs.
- In general, prefer [sociable over solitary tests].
- Commit messages should describe both what is being changed and why it is
  being changed.

### Monitoring and Observability

- Make liberal use of [Prometheus metrics] to aid in monitoring and debugging.
- Follow the Prometheus [metrics naming recommendations].

[docker compose]: https://docs.docker.com/compose/install/
[envoy]: https://www.envoyproxy.io/
[idempotent]: https://en.wikipedia.org/wiki/Idempotence
[compile test suite]: https://martinfowler.com/bliki/UnitTest.html
[sociable over solitary tests]: https://martinfowler.com/bliki/UnitTest.html
[prometheus metrics]: https://github.com/siimon/prom-client
[metrics naming recommendations]: https://prometheus.io/docs/practices/naming/
