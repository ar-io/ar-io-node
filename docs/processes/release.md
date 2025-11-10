# Release Process

## Release

1. Run security audit: `yarn audit` to check for vulnerabilities before release.
2. Ensure all relevant changes are merged into `develop`.
3. Find the relevant release ticket in JIRA with the AR.IO component (e.g., search for "Release N" in project PE).
4. Review `CHANGELOG.md` and ensure all changes have been documented.
5. Add the release date and release number to `CHANGELOG.md`.
6. Remove the "-pre" suffix from the `release` constant in `src/version.ts`.
7. Set AR_IO_NODE_RELEASE environment variable in `docker-compose.yaml` to the
   same value used in `src/version.ts`.
8. Commit the version change with the JIRA ticket reference and push to `develop`.
9. Once image builds are complete, update the image tags in `docker-compose.yaml`
   to use the git commit SHA from the release commit (not the release number).
   Update clickhouse-auto-import, core, envoy, and litestream image tags.
10. AO CU and observer images should remain pinned and are not updated during
   normal releases unless explicitly needed for compatibility or bug fixes.
11. Test the release by starting docker compose with each profile to verify
   containers start and produce logs:
   - `docker compose up -d` (default profile)
     - Core containers (envoy, core, redis, observer) must stay running
   - `docker compose --profile clickhouse --profile litestream --profile otel down && docker compose --profile clickhouse up -d`
     - Adds clickhouse and clickhouse-auto-import containers
   - `docker compose --profile clickhouse --profile litestream --profile otel down && docker compose --profile litestream up -d`
     - Litestream may exit if S3 not configured (expected behavior)
   - `docker compose --profile clickhouse --profile litestream --profile otel down && docker compose --profile otel up -d`
     - OTEL collector may exit if endpoint not configured (expected behavior)
   - `docker compose --profile clickhouse --profile litestream --profile otel down && docker compose up -d && docker compose -f docker-compose.yaml -f docker-compose.ao.yaml up -d`
     - AO CU may restart if not configured (expected behavior)
   - Verify core containers stay running: `docker ps | grep -E "envoy|core|redis|observer"`
   - After testing, stop all: `docker compose -f docker-compose.yaml -f docker-compose.ao.yaml --profile clickhouse --profile litestream --profile otel down`
12. Tag the release in git: `git tag r47` (replace with appropriate release number)
13. Push the tag: `git push origin r47`
14. Create GitHub release using the tag:
    ```bash
    gh release create r[N] \
      --title "Release [N]" \
      --notes "Release notes from CHANGELOG with docker image SHAs"
    ```
    - Include the release summary from CHANGELOG
    - List all docker images with their specific SHAs
15. Merge to `main`.

## Post Release

1. Switch back to the `develop` branch.
2. Bump the release number and add a "-pre" suffix to `release` constant in
   `src/version.ts`.
3. Set AR_IO_NODE_RELEASE environment variable in `docker-compose.yaml` to the
   same value used in `src/version.ts`.
4. Set clickhouse-auto-import, core, envoy, and litestream image tags back to
   `latest` in `docker-compose.yaml`. AO CU and observer images should remain
   pinned.
5. Create a new `[Unreleased]` entry in `CHANGELOG.md`.
