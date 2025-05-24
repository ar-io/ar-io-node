# Repo Navigation Guide

This repository contains the AR.IO gateway node written primarily in **TypeScript**.
The codebase follows a conventional layout:

- `src/` – main application source files.
- `test/` – end-to-end and unit tests.
- `features/` – cucumber feature files and step definitions.
- `docs/` – documentation and diagrams.
- `migrations/` – SQL migration scripts.
- `scripts/` – helper shell scripts.
- `docker-compose.yaml` – compose stack for development.

## Development

- Install dependencies with **Yarn** (`yarn install`). Node 20 is expected (`.nvmrc`).
- Build the project with `yarn build`.
- Run the service in development via `yarn start`.

## Testing

- Lint source and tests using `yarn lint:check`; auto-fix issues with `yarn lint:fix`.
- Unit and integration tests run with `yarn test`. Coverage uses `yarn test:ci`.
- End-to-end tests (Docker based) run with `yarn test:e2e`.
- Cucumber feature tests run with `yarn test:features`.

## Style

- Prettier enforces 2‑space indent, single quotes and trailing commas (`.prettierrc`).
- ESLint configuration requires the license header from `resources/license.header.js` at the top of source files.

## Misc

- Environment variables for configuration are documented in `docs/envs.md`.
- Release workflow notes are in `docs/release-process.md`.
- Diagram generation targets live in `Makefile`.

