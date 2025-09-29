# Release Process

## Release

1. Ensure all relevant changes are merged into `develop`.
2. Review `CHANGELOG.md` and ensure all changes have been documented.
3. Add the release date and release number to `CHANGELOG.md`.
4. Remove the "-pre" suffix from the `release` constant in `src/version.ts`.
5. Set AR_IO_NODE_RELEASE environment variable in `docker-compose.yaml` to the
   same value used in `src/version.ts`.
6. Commit the version change and push to `develop`.
7. Once image builds are complete, update the image tags in `docker-compose.yaml`
   to use the git commit SHA from the release commit (not the release number).
   Update clickhouse-auto-import, core, envoy, and litestream image tags.
8. AO CU and observer images should remain pinned and are not updated during
   normal releases unless explicitly needed for compatibility or bug fixes.
9. Test the release by starting docker compose with each profile to verify
   containers start and produce logs:
   - `docker compose up -d` (default profile)
     - Core containers (envoy, core, redis, observer) must stay running
   - `docker compose down && docker compose --profile clickhouse up -d` 
     - Adds clickhouse and clickhouse-auto-import containers
   - `docker compose down && docker compose --profile litestream up -d`
     - Litestream may exit if S3 not configured (expected behavior)
   - `docker compose up -d && docker compose -f docker-compose.yaml -f docker-compose.ao.yaml up -d`
     - AO CU may restart if not configured (expected behavior)
   - Verify core containers stay running: `docker ps | grep -E "envoy|core|redis|observer"`
   - After testing, stop all: `docker compose -f docker-compose.yaml -f docker-compose.ao.yaml down`
10. Tag the release in git: `git tag r47` (replace with appropriate release number)
11. Push the tag: `git push origin r47`
12. Create GitHub release using the tag:
    ```bash
    gh release create r[N] \
      --title "Release [N]" \
      --notes "Release notes from CHANGELOG with docker image SHAs"
    ```
    - Include the release summary from CHANGELOG
    - List all docker images with their specific SHAs
13. Merge to `main`.

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
