# Release Process

## Release

1. Ensure all relevant changes are merged into `develop`.
1. Review `CHANGELOG.md` and ensure all changes have been documented.
1. Add the release date and release number to `CHANGELOG.md`.
1. Remove the "-pre" suffix from the `release` constant in `src/version.ts`.
1. Set AR_IO_NODE_RELEASE environment variable in `docker-compose.yaml` to the
   same value used in `src/version.ts`.
1. Commit the version change and push to `develop`.
1. Once images builds are complete, set the clickhouse-auto-import, core,
   envoy, and litestream image tags in `docker-compose.yaml`.
1. Set the AO CU image tag to the current stable tag in
   `docker-compose.ao.yaml`.
1. Tag the release in git.
1. Merge to `main`.

## Post Release

1. Switch back to the `develop` branch.
1. Bump the release number and add a "-pre" suffix to `release` constant in
   `src/version.ts`.
1. Set AR_IO_NODE_RELEASE environment variable in `docker-compose.yaml` to the
   same value used in `src/version.ts`.
1. Set clickhouse-auto-import, core, envoy, and litestream image tags back to
   `latest` in `docker-compose.yaml`.
1. Set the AO cu image back to `latest` in `docker-compose.ao.yaml`.
1. Create a new `[Unreleased]` entry in `CHANGELOG.md`.
