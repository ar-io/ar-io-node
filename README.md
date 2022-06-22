# AR.IO Gateway Node

## Dev Workflow

### Install Dependencies

`yarn install`

### Running tests

`yarn test`

### Initializing/reseting the Sqlite DB

Note: this erases the DB!

`./reset-db.sh`

### Running the service

With defaults:

`yarn start`

Starting at an arbitrary block (after DB reset only):

`START_HEIGHT=800000 yarn start`

## Design principles

1. Code to interfaces.
2. Separate IO from logic.
3. Make processes idempotent.
4. All components must be runnable in a single process.
5. All components should be runnable independently.
6. Keep regression tests blazingly fast.
7. Prefer integration over unit tests.
8. Prefer in-memory implementations over mocks and stubs.
