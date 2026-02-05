# AR.IO Gateway Node

[![codecov](https://codecov.io/gh/ar-io/ar-io-node/graph/badge.svg?token=F3BJ7W74HY)](https://codecov.io/gh/ar-io/ar-io-node)
[![protocol.land](https://arweave.net/eZp8gOeR8Yl_cyH9jJToaCrt2He1PHr0pR4o-mHbEcY)](https://protocol.land/#/repository/713c1b6f-86c8-493e-b2e6-6cb231862b93)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ar-io/ar-io-node)

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

You can also run [Envoy] alongside an `ar.io` node via [Docker Compose]. Envoy
will proxy routes to `arweave.net` not yet implemented in the ar.io node.

```shell
docker compose up --build
```

Once running, requests can be directed to Envoy server at `localhost:3000`.

### Run a Turbo Bundler as a Sidecar

You can run a [Turbo] [ANS-104] data item bundler as a sidecar to the ar.io gateway service. This will allow the deployed system to accept data items and bundle them into a single transaction before submitting them to the network. The bundler's APIs will be reachable at the `/bundler/` path. For more information on its APIs, you can access docs at `/bundler/api-docs/`.

Note: A local bundler configured to integrate with an ar.io node relies upon GraphQL indexing of recently bundled and uploaded data to manage its pipeline operations. The ar.io node should have its indexes synced up to Arweave's current block height minus 18 blocks before starting up the bundler's services stack.

Bundling services are most easily managed via an independent docker compose file whose services share their network with that of the core services docker compose stack. This allows you to spin the services up when your core service is prepared to integrate with it, or down whenever you want without affecting your core services stack.

To get started, supply the required environment variables in an environment variables file (e.g. `.env.bundler`) for the integration, most notably:

- `BUNDLER_ARWEAVE_WALLET`: a stringified JWK wallet used for uploading bundles to Arweave.
- `ALLOW_LISTED_ADDRESSES`: a comma-separated list of allowed uploader wallet addresses (normalized). See [Managing Bundler Access](#managing-bundler-access) for more permissioning options.

See the `.env.bundler.example` file for other important configuration options, including settings for serving bundler-uploaded data items instantly from your gateway.

Once environment variables are set, run docker compose with the bundler-specific compose file.

```shell
docker compose --env-file ./.env.bundler --file docker-compose.bundler.yaml up
```

Now, the bundler service will be running alongside the ar.io gateway. Your gateway will now accept data items at `<your gateway url>/bundler/tx` 🚀

#### Managing Bundler Access

By default, the bundler will only accept data items uploaded by data item signers whose normalized wallet addresses are in the `ALLOW_LISTED_ADDRESSES` list. But the following other permissioning configuration schemes are possible:

| Scheme                 | ALLOW_LISTED_ADDRESSES                      | SKIP_BALANCE_CHECKS | ALLOW_LISTED_SIGNATURE_TYPES | PAYMENT_SERVICE_BASE_URL |
| ---------------------- | ------------------------------------------- | ------------------- | ---------------------------- | ------------------------ |
| Allow specific wallets | comma-separated normalized wallet addresses | false               | EMPTY or supplied            | EMPTY                    |
| Allow specific chains  | EMPTY or supplied                           | false               | arbundles sigtype int        | EMPTY                    |
| Allow all              | n/a                                         | true                | n/a                          | n/a                      |
| Allow none             | EMPTY                                       | false               | EMPTY                        | EMPTY                    |
| Allow payers           | EMPTY or supplied                           | false               | EMPTY or supplied            | your payment svc url     |

### Run an AO Compute Unit (CU) as a Sidecar

AO Compute Units are useful for interacting with AO Processes in manner that avoids Process side effects and that does not require gas payment via "[Dry Runs]".

AO CU's rely on bundlers to periodically upload checkpoint data for evaluated Process memory. Additionally, they rely on gateway GQL to find those checkpoints, Scheduler assignments for each Process, and more. The indexing workload to support arbitrary AO Processes is effectively the indexing workload for most of Arweave's recent history. However, most recent AO Testnet Processes's data was bundled by Turbo in dedicated bundles with the tag:

```
Bundler-App-Name: AO
```

Including that tag filter in your indexing filters and indexing data from block height 1378000 forward should include the vast majority of the needed testnet data.

If you control your own SU and can easily identify its L1 data transactions' tags, you can simply filter on those from a block height that captures all of the SU data for your processes of interest.

Similarly to the bundler sidecar, the CU service is most easily managed via an independent docker compose file whose services share their network with that of the core services docker compose stack.

To get started, supply the required environment variables in an environment variables file (e.g. `.env.ao`) for the integration, most notably:

- `CU_WALLET`: a stringified JWK wallet used for uploading CU checkpoints to Arweave.
- `PROCESS_CHECKPOINT_TRUSTED_OWNERS`: a comma-separated list of CU checkpoint uploader wallet addresses(normalized).

See the `.env.ao.example` or the environment overrides in `docker-compose.ao.yaml` file for other important configuration options.

Once environment variables are set, run docker compose with the ao-specific compose file.

```shell
docker compose --env-file ./.env.ao --file docker-compose.ao.yaml up
```

Now, the CU service will be running alongside the ar.io gateway. Within the docker network it can be reached at `http://envoy:3000/ao/cu` and `http://ao-cu:6363`. From the docker host machine, it can be reached at `http://localhost:3000/ao/cu` and `http://localhost:6363`. From your custom domain configured to forward traffic to envoy, it can be reached at `<your gateway url>/ao/cu`.

## Configuration

When running via `docker compose`, it will read a `.env` file in the project root
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
{ "attributes": { "owner_address": <owner address>, ... }}
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

For detailed information about filter types, operators, and advanced examples, see [Filter Documentation](docs/filters.md).

### Root Transaction Index (CDB64)

The ar.io gateway uses a root transaction index to efficiently resolve data item
IDs to their containing L1 Arweave transactions. Starting with Release 67, the
gateway ships with a pre-built CDB64 index enabled by default, providing O(1)
lookups for historical data items without requiring local indexing or network
requests.

The default index covers non-AO, non-Redstone data items with content types up
to block height 1,820,000 (~964 million records).

#### Configuration

The lookup order is controlled by `ROOT_TX_LOOKUP_ORDER`:

```
ROOT_TX_LOOKUP_ORDER=db,gateways,cdb,graphql
```

Available sources (in recommended order):
- `db` - Local SQLite database
- `gateways` - AR.IO gateway HEAD requests
- `cdb` - CDB64 file-based index
- `graphql` - GraphQL queries to trusted gateways
- `turbo` - Turbo API

To disable CDB64 lookups, remove `cdb` from the lookup order.

#### Custom Index Sources

Custom CDB64 index sources can be configured via `CDB64_ROOT_TX_INDEX_SOURCES`:

```
# Local file or directory
CDB64_ROOT_TX_INDEX_SOURCES=/path/to/index.cdb

# Multiple sources (tried in order)
CDB64_ROOT_TX_INDEX_SOURCES=/local/index.cdb,https://cdn.example.com/index/

# Arweave transaction (43-character base64url ID)
CDB64_ROOT_TX_INDEX_SOURCES=ABC123def456xyz789ABC123def456xyz789ABC12

# Bundle data item (txId:offset:size format)
CDB64_ROOT_TX_INDEX_SOURCES=TxId123...:1024:245760
```

For partitioned indexes, point to a directory containing `manifest.json` or
append `:manifest` to an Arweave transaction ID.

#### Remote Index Configuration

When using HTTP or Arweave-based indexes:

```
CDB64_REMOTE_RETRIEVAL_ORDER=gateways,chunks    # Data sources for fetching CDB files
CDB64_REMOTE_CACHE_MAX_REGIONS=100              # Max cached byte-range regions
CDB64_REMOTE_CACHE_TTL_MS=300000                # Cache TTL (5 minutes)
CDB64_REMOTE_REQUEST_TIMEOUT_MS=30000           # Request timeout
CDB64_REMOTE_MAX_CONCURRENT_REQUESTS=4          # Concurrent HTTP request limit
```

#### File Watching

By default, local CDB64 directories are watched for changes. New `.cdb` files
are automatically loaded without restart:

```
CDB64_ROOT_TX_INDEX_WATCH=true   # Enable/disable file watching
```

For detailed information about the CDB64 file format and tools, see
[CDB64 Format Documentation](docs/cdb64-format.md).

### Webhook Emission

The ar.io gateway includes a feature to emit webhooks to specified servers when a transaction or data item is indexed and matches a predefined filter. This feature allows for real-time notifications and integrations based on the transaction and data indexing.

To use this feature, you need to set up two environment variables in your `.env` file:

1. **WEBHOOK_TARGET_SERVERS**: This is a comma-separated list of servers where the webhooks will be sent.

   Format: `WEBHOOK_TARGET_SERVERS="<server1>,<server2>,..."`

2. **WEBHOOK_INDEX_FILTER**: This filter determines which transactions or data items will trigger the webhook emission.

3. **WEBHOOK_BLOCK_FILTER**: This filter determines which blocks will trigger the webhook emission.

The filter syntax is identical to `ANS104_INDEX_FILTER`. Supported filter types include:

- `{ "never": true }` (default)
- `{ "always": true }`
- `{ "attributes": { "owner": <owner key>, ... }}`
- `{ "tags": [{ "name": <utf8 tag name>, "value": <utf8 tag value> }, { "name": <utf8 tag name> }, ...]}`
- `{ "and": [ <nested filter>, ... ]}`
- `{ "or": [ <nested filter>, ... ]}`

Example: `WEBHOOK_INDEX_FILTER="{ "tags": [{ "name": "App-Name", "value": "MyApp" }, { "name": "IPFS-Add" }]}"`

After setting up the environment variables, the ar.io gateway will monitor for transactions or data items that match the `WEBHOOK_INDEX_FILTER`. Once a match is found, a webhook will be emitted to all the servers listed in `WEBHOOK_TARGET_SERVERS`.

Ensure that the target servers are configured to receive and process these webhooks appropriately.

For detailed information about filter types, operators, and advanced examples, see [Filter Documentation](docs/filters.md).

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

### Monitoring and Observability

The ar-io-node leverages [Prometheus] to collect metrics from the system and
recommends [Grafana] to visualize them. To access a templated Grafana dashboard
for the ar.io gateway, you can run:

```
docker compose --file docker-compose.grafana.yaml up -d
```

Once the dashboard is running, you can access it at
`http://localhost:1024/grafana` and login with the username and password
`admin`.

This dashboard is pre-configured to work with the ar.io gateway metrics exposed
via the `ar-io-core` service and is ready to be used without any additional
configuration for simple observability. You can modify the dashboard to better
fit your needs by editing the `dashboard.json` file. Refer to the [Grafana
documentation] to learn more about how to create and modify Grafana dashboards
using JSON model files.

#### OpenTelemetry and Distributed Tracing

The ar-io-node uses [OpenTelemetry] for distributed tracing, providing deep visibility into request flows and performance bottlenecks. When deployed with docker-compose, traces are automatically routed through an **OTEL Collector sidecar** that implements intelligent **tail-based sampling** to reduce telemetry costs by 80-95% while maintaining complete visibility into errors and performance issues.

**How Tail Sampling Works:**

Unlike traditional head-based sampling (which decides whether to keep a trace at the start), tail sampling waits until the entire trace completes before making a decision. This enables five intelligent sampling policies:

1. **100% Error Capture**: All traces with errors (5xx responses, exceptions) are captured
2. **100% Slow Request Capture**: All requests exceeding 2 seconds (configurable) are captured
3. **100% Payment Capture**: All traces with verified x402 payments are captured for billing and compliance
4. **100% Paid Token Capture**: All traces that consumed paid rate limit tokens are captured
5. **Probabilistic Baseline**: 1% (configurable) of successful, fast, unpaid requests for baseline metrics

This approach ensures you never miss critical failures, paid traffic, or compliance-relevant requests while dramatically reducing storage and analysis costs for free-tier traffic.

**Configuration:**

To use OTEL Collector with tail sampling in docker-compose:

1. Set your telemetry destination and API key (configure ONE based on your backend):
   ```bash
   # Honeycomb
   OTEL_COLLECTOR_DESTINATION_ENDPOINT=https://api.honeycomb.io
   OTEL_COLLECTOR_HONEYCOMB_API_KEY=your-honeycomb-api-key

   # OR Grafana Cloud Tempo
   OTEL_COLLECTOR_DESTINATION_ENDPOINT=https://otlp-gateway-prod-us-central-0.grafana.net/otlp
   OTEL_COLLECTOR_GRAFANA_CLOUD_API_KEY=your-base64-encoded-key

   # OR Datadog
   OTEL_COLLECTOR_DESTINATION_ENDPOINT=https://trace.agent.datadoghq.com
   OTEL_COLLECTOR_DATADOG_API_KEY=your-datadog-api-key

   # OR New Relic
   OTEL_COLLECTOR_DESTINATION_ENDPOINT=https://otlp.nr-data.net
   OTEL_COLLECTOR_NEW_RELIC_API_KEY=your-new-relic-license-key

   # OR Elastic APM
   OTEL_COLLECTOR_DESTINATION_ENDPOINT=https://your-deployment.apm.region.cloud.es.io
   OTEL_COLLECTOR_ELASTIC_API_KEY=your-elastic-secret-token
   ```

2. Optionally adjust sampling parameters:
   ```bash
   # Sample 5% of successful requests instead of 1%
   OTEL_TAIL_SAMPLING_SUCCESS_RATE=5

   # Capture requests slower than 1 second instead of 2
   OTEL_TAIL_SAMPLING_SLOW_THRESHOLD_MS=1000
   ```

3. Start the stack:
   ```bash
   docker compose up -d
   ```

The collector runs automatically as part of the docker-compose stack. Traces flow through: `ar-io-node` → `otel-collector` → `your telemetry backend`.

**Non-Docker Deployments:**

For non-docker deployments, you can send traces directly to your telemetry backend by setting:
```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=your-api-key
```

Note: Direct export bypasses tail sampling and uses head-based sampling via `OTEL_TRACING_SAMPLING_RATE_DENOMINATOR`.

**Supported Telemetry Backends:**

The OTEL Collector works with any OTLP-compatible backend:
- Honeycomb
- Grafana Cloud (Tempo)
- Datadog
- New Relic
- Elastic APM
- Self-hosted: Jaeger, Zipkin, Tempo

For complete configuration options, see the [environment variables documentation](docs/envs.md).

[OpenTelemetry]: https://opentelemetry.io/

### Log Filtering

The AR.IO Node supports filtering Winston logs with the `LOG_FILTER`
environment variable (or `CORE_LOG_FILTER` when using docker-compose). This
helps reduce log noise by showing only logs that match specific criteria.

Filter logs using the same JSON-based filtering syntax used for bundle filters,
with the filter logic applying to log attributes instead of bundle attributes:

```
# Only show logs from ArNS resolvers
LOG_FILTER={"attributes":{"class":"CompositeArNSResolver"}}

# Only show logs from the on-demand ArNS resolver
LOG_FILTER={"attributes":{"class":"OnDemandArNSResolver"}}

# Show logs from multiple ArNS components using logical operators
LOG_FILTER={"or":[{"attributes":{"class":"CompositeArNSResolver"}},{"attributes":{"class":"OnDemandArNSResolver"}}]}
```

For more details on filter syntax, see the [filter
documentation](docs/filters.md) - while this documentation focuses on bundle
filters, the filter structure and logic apply to log filtering as well.

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
[turbo]: https://github.com/ardriveapp/turbo-upload-service/
[Dry Runs]: https://github.com/permaweb/ao/blob/main/connect/README.md#dryrun
[Grafana]: https://grafana.com/
[Grafana documentation]: https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/view-dashboard-json-model/
[Prometheus]: https://prometheus.io/
