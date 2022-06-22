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
3. Make processes idempotent.
4. All components must be runnable in a single process.
5. All components should be runnable independently.
6. Keep regression tests blazingly fast.
7. Prefer integration over unit tests.
8. Prefer in-memory implementations over mocks and stubs.
