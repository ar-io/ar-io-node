# Release Process

## Release

1. Ensure all relevant changes are merged into `develop`.
2. Review `CHANGELOG.md` and ensure all changes have been documented.
3. Add the release date and release number to `CHANGELOG.md`.
4. Remove the "-pre" suffix from the `release` constant in `src/version.ts`.
5. Set AR_IO_NODE_RELEASE environment variable in `docker-compose.yaml` to the
   same value used in `src/version.ts`.
6. Commit the version change and push to `develop`.
7. Once images builds are complete, set the clickhouse-auto-import, core,
   envoy, and litestream image tags in `docker-compose.yaml`.
8. Set the AO CU image tag to the current stable tag in
   `docker-compose.ao.yaml`.
9. Tag the release in git.
10. Merge to `main`.

## Post Release

1. Switch back to the `develop` branch.
2. Bump the release number and add a "-pre" suffix to `release` constant in
   `src/version.ts`.
3. Set AR_IO_NODE_RELEASE environment variable in `docker-compose.yaml` to the
   same value used in `src/version.ts`.
4. Set clickhouse-auto-import, core, envoy, and litestream image tags back to
   `latest` in `docker-compose.yaml`.
5. Set the AO cu image back to `latest` in `docker-compose.ao.yaml`.
6. Create a new `[Unreleased]` entry in `CHANGELOG.md`.
