# AR.IO Gateway Node

## Dev Workflow

### Install dependencies

`yarn install`

### Run tests

`yarn test`

### Initialize the Sqlite DB

Note: this erases the DB!

`yarn db:migrate`

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
docker build . -t ario-node:latest
docker run -p 4000:4000 -v ario-data:/app/data ario-node:latest
```

To reset the db:

```shell
docker run -v  $PWD/data:/app/data ario-node:latest sh reset-db.sh
```

To run with a specified start height (after a reset):

```shell
docker run -e START_HEIGHT=800000 -v $PWD/data/:/app/data ario-node:latest
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

Once running, requests can be directed to envoy server at `localhost:3000`.

## Design Principles

1. Code to interfaces.
2. Separate IO from logic.
3. Make processes [idempotent].
4. All components must be runnable in a single process.
5. All components should be runnable independently.
6. Seperate mutable from immutable data.
7. Keep regression tests blazingly fast.
8. Prefer integration over unit tests.
9. Prefer in-memory implementations over mocks and stubs.
10. Avoid naively trusting data when the cost to validate it is low.
11. Make liberal use of [metrics] to aid in monitoring and debugging.
12. Follow the Prometheus [metrics namings recommendations].
13. Commit messages should describe both the what and why of the change being made.

[docker compose]: https://docs.docker.com/compose/install/
[envoy]: https://www.envoyproxy.io/
[idempotent]: https://en.wikipedia.org/wiki/Idempotence
[metrics]: https://github.com/siimon/prom-client
[metrics namings recommendations]: https://prometheus.io/docs/practices/naming/
