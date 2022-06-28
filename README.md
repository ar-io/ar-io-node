# AR.IO Gateway Node

## Dev Workflow

### Install dependencies

`yarn install`

### Run tests

`yarn test`

### Initialize/reset the Sqlite DB

Note: this erases the DB!

`./reset-db.sh`

### Run the service

With defaults:

`yarn start`

Starting at an arbitrary block (only works immediately after a DB reset):

`START_HEIGHT=800000 yarn start`

## Design Principles

1. Code to interfaces.
2. Separate IO from logic.
3. Make processes [idempotent](https://en.wikipedia.org/wiki/Idempotence).
4. All components must be runnable in a single process.
5. All components should be runnable independently.
6. Seperate mutable from immutable data.
7. Keep regression tests blazingly fast.
8. Prefer integration over unit tests.
9. Prefer in-memory implementations over mocks and stubs.
10. Avoid naively trusting data when the cost to validate it is low.
11. Make liberal use of [metrics](https://github.com/siimon/prom-client) to aid in monitoring and debugging.
12. Follow the Prometheus [metrics namings recommendations](https://prometheus.io/docs/practices/naming/).
13. Commit messages should describe both the what and why of the change being made.
