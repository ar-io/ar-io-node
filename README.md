# AR.IO Gateway Node

[![codecov](https://codecov.io/gh/ar-io/ar-io-node/graph/badge.svg?token=F3BJ7W74HY)](https://codecov.io/gh/ar-io/ar-io-node)
[![protocol.land](https://arweave.net/eZp8gOeR8Yl_cyH9jJToaCrt2He1PHr0pR4o-mHbEcY)](https://protocol.land/#/repository/713c1b6f-86c8-493e-b2e6-6cb231862b93)

## Getting Started

- [Linux Installation Instructions](./docs/linux-setup.md)
- [Windows Installation Instructions](./docs/windows-setup.md)

## Dev Workflow

### Install dependencies

`yarn install`

### Initialize the SQLite DB

`yarn db:migrate up`

### Run lint

`yarn lint:check`

### Run tests

`yarn test`

### Run the service

With defaults:

`yarn start`

Starting at an arbitrary block (only works immediately after initial DB
migration):

`START_HEIGHT=800000 yarn start`

## Dev Docs

### Schema (WIP)

- [Bundle schema]

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
directory and use the environment variables set there.

### GraphQL Pass-Through

Add the following to your `.env` file to proxy GraphQL to another server while
using the ar.io gateway to serve data (using arweave.net GraphQL as an example):

```
GRAPHQL_HOST=arweave.net
GRAPHQL_PORT=443
```

### Unbundling

The ar.io gateway supports unbundling and indexing [ANS-104] bundle data. To
enable this add the following environment variables to your `.env` file:

```
ANS104_UNBUNDLE_FILTER="<filter string>"
ANS104_INDEX_FILTER="<filter string>"
```

`ANS104_UNBUNDLE_FILTER` determines which TXs and data items (in the case of
nested bundles) are unbundled, and `ANS104_INDEX_FILTER` determines which data
items within a bundle get indexed.

The following types of filters are supported:

```
{ "never": true } # the default
{ "always": true }
{ "attributes": { "owner": <owner key>, ... }}
{ "tags": [{ "name": <utf8 tag name>, "value": <utf8 tag value> }, { "name": <utf8 tag name> }, ...]}
{ "and": [ <nested filter>, ... ]}
{ "or": [ <nested filter>, ... ]}
{ "not": [ <nested filter>, ... ]}

```

Place an ANS-104 bundle at the start of the queue for unbundling and indexing
on your gateway:

```
curl -X PUT -H "Authorization: Bearer <ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  "http://<HOST>:<PORT>/ar-io/admin/queue-tx" \
  -d '{ "id": "<ID>" }'

```

Note: ANS-104 indexing support is currently experimental. It has been tested
successfully with small sets of bundles (using filters), but you may still
encounter problems with it when indexing larger sets of transactions.

### Webhook Emission

The ar.io gateway includes a feature to emit webhooks to specified servers when a transaction or data item is indexed and matches a predefined filter. This feature allows for real-time notifications and integrations based on the transaction and data indexing.

To use this feature, you need to set up two environment variables in your `.env` file:

1. **WEBHOOK_TARGET_SERVERS**: This is a comma-separated list of servers where the webhooks will be sent.

   Format: `WEBHOOK_TARGET_SERVERS="<server1>,<server2>,..."`

2. **WEBHOOK_INDEX_FILTER**: This filter determines which transactions or data items will trigger the webhook emission.

2. **WEBHOOK_BLOCK_FILTER**: This filter determines which blocks will trigger the webhook emission.

  The filter syntax is identical to `ANS104_INDEX_FILTER`. Supported filter types include:
  - `{ "never": true }` (default)
  - `{ "always": true }`
  - `{ "attributes": { "owner": <owner key>, ... }}`
  - `{ "tags": [{ "name": <utf8 tag name>, "value": <utf8 tag value> }, { "name": <utf8 tag name> }, ...]}`
  - `{ "and": [ <nested filter>, ... ]}`
  - `{ "or": [ <nested filter>, ... ]}`

  Example: `WEBHOOK_INDEX_FILTER="{ "tags": [{ "name": "App-Name", "value": "MyApp" }, { "name": "IPFS-Add" }]}"`


After setting up the environment variables, the ar.io gatway will monitor for transactions or data items that match the `WEBHOOK_INDEX_FILTER`. Once a match is found, a webhook will be emitted to all the servers listed in `WEBHOOK_TARGET_SERVERS`.

Ensure that the target servers are configured to receive and process these webhooks appropriately.

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

### Wallet association

In order to participate in the [ar.io network](https://ar.io/), gateways need
to associate themselves with a wallet. This can be configured by setting the
`AR_IO_WALLET` environment variable. Once set, the associated wallet address is
visible via the `/ar-io/info` endpoint.

Similarly, network participants must make observations of other gateways and
submit them. The wallet for this is configured using the `OBSERVER_WALLET`
environment variable. An associated key file is also required to upload
observation reports. The key file must be placed in
`./wallets/<OBSERVER_WALLET>.json` (`<OBSERVER_WALLET>` should be replaced with
the address of the wallet you are using).

### Admin API key

HTTP endpoints under '/ar-io/admin' are protected by an admin API key. On startup,
the admin key is read from the `ADMIN_API_KEY` environment variable. If no key is
set, a random key is generated and logged. To make a request to an admin endpoint
add an `Authorization: Bearer <ADMIN_API_KEY>` header to your request.

### Content Moderation

Block a specific TX/data item ID on your gateway:

```
curl -X PUT -H "Authorization: Bearer <ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  "http://<HOST>:<PORT>/ar-io/admin/block-data" \
  -d '{ "id": "<ID>", "notes": "Example notes", "source": "Example source" }'

```

`notes` and `source` are for documentation only. `source` is intended to be an
identifier of a particular source of IDs to block (e.g. the name of a
blocklist). `notes` is a text field that can be used to further describe why a
particular ID is blocked.

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

[ans-104]: https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md
[docker compose]: https://docs.docker.com/compose/install/
[envoy]: https://www.envoyproxy.io/
[bundle schema]: https://ar-io.github.io/ar-io-node/schema/sqlite/bundles/index.html
[idempotent]: https://en.wikipedia.org/wiki/Idempotence
[compile test suite]: https://martinfowler.com/bliki/UnitTest.html
[sociable over solitary tests]: https://martinfowler.com/bliki/UnitTest.html
[prometheus metrics]: https://github.com/siimon/prom-client
[metrics naming recommendations]: https://prometheus.io/docs/practices/naming/
