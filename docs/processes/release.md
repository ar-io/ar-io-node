# Release Process

The preferred way to cut a release is via the `release` skill
(`.claude/skills/release/SKILL.md`) — tell Claude "prepare release N" and it
drives the phases below using the small tools under `tools/`. The manual
checklist remains authoritative.

## Tools

All mutations below are performed by narrow, idempotent tools:

| Tool                              | What it does                                                            |
| --------------------------------- | ----------------------------------------------------------------------- |
| `./tools/release-info [--json]`   | Reports version, `AR_IO_NODE_RELEASE`, changelog state, image tag defaults |
| `./tools/set-version <value>`     | Updates `release` in `src/version.ts`                                   |
| `./tools/set-ar-io-node-release <value>` | Updates `AR_IO_NODE_RELEASE` default in `docker-compose.yaml`     |
| `./tools/set-image-tag <VAR> <value>`    | Updates one `*_IMAGE_TAG` default                                |
| `./tools/changelog-release <N>`   | `## [Unreleased]` → `## [Release N] - <date>`                           |
| `./tools/changelog-add-unreleased` | Adds a fresh `## [Unreleased]` section                                 |

See `tools/README.md` for usage details.

## Release-managed images

These image env vars are flipped to a SHA at finalize and back to `latest` at
post-release:

- `ENVOY_IMAGE_TAG`
- `CORE_IMAGE_TAG`
- `CLICKHOUSE_AUTO_IMPORT_IMAGE_TAG`
- `LITESTREAM_IMAGE_TAG`

`OBSERVER_IMAGE_TAG` stays pinned across releases and is only bumped
intentionally.

## Phases

### 1. Preflight

1. `./tools/release-info` — confirm:
   - `versionIsPre === true` (e.g., `53-pre`)
   - `arIoNodeRelease` matches `version`
   - `changelogUnreleasedHasContent === true`
   - All release-managed image tags are `latest`
2. `git status` — working tree clean, on `develop`
3. `yarn audit` — review; bail on high-severity vulnerabilities
4. Find the Jira release ticket (search for "Release N" in project PE)
5. Review `CHANGELOG.md` — ensure all changes are documented

### 2. Prepare

```bash
./tools/changelog-release <N>
./tools/set-version <N>
./tools/set-ar-io-node-release <N>

git add CHANGELOG.md src/version.ts docker-compose.yaml
git commit -m "chore: prepare release <N> (PE-####)"
git push origin develop
```

The push triggers image builds on GitHub Actions.

### 3. Finalize (after image builds)

Wait for GitHub Actions to finish:

```bash
gh api repos/ar-io/ar-io-node/actions/runs \
  --jq '.workflow_runs[] | select(.status == "in_progress" or .status == "queued") | .id' \
  | wc -l
```

Fetch the git-SHA tag for each release-managed image from ghcr.io:

```bash
for image in ar-io-envoy ar-io-core ar-io-clickhouse-auto-import ar-io-litestream; do
  sha=$(gh api "/orgs/ar-io/packages/container/${image}/versions" \
    --jq '.[0].metadata.container.tags[] | select(. != "latest")' | head -1)
  echo "${image}: ${sha}"
  git rev-parse --verify "$sha"  # must exist in git history
done
```

Apply each SHA with `set-image-tag` (see mapping in skill doc), then commit:

```bash
git add docker-compose.yaml
git commit -m "chore: finalize release <N> with image SHAs (PE-####)"
git push origin develop
```

### 4. Test docker compose profiles

Core containers expected to stay running across every profile: `envoy`,
`core`, `redis`, `observer`. Check with `docker ps --format '{{.Names}}'`.

Between profiles, cleanup:

```bash
docker compose --profile clickhouse --profile litestream --profile otel down
```

| Profile    | Up command                                                          | Expected                                                           |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| default    | `docker compose up -d`                                              | core stable after 30s + 15s recheck                                |
| clickhouse | `docker compose --profile clickhouse up -d`                         | core + `clickhouse`, `clickhouse-auto-import`                      |
| litestream | `docker compose --profile litestream up -d`                         | core; `litestream` may exit without S3 (expected)                  |
| otel       | `docker compose --profile otel up -d`                               | core; `otel-collector` may exit without endpoint (expected)        |

After testing, run the cleanup command again.

### 5. Tag & publish

```bash
git tag r<N>
git push origin r<N>

gh release create r<N> \
  --title "Release <N>" \
  --notes "<release notes from CHANGELOG + image SHAs from release-info>"
```

### 6. Merge to main

```bash
git checkout main
git pull
git merge --ff-only develop
git push origin main
git checkout develop
```

### 7. Post-release

```bash
./tools/set-version <N+1>-pre
./tools/set-ar-io-node-release <N+1>-pre
for var in ENVOY_IMAGE_TAG CORE_IMAGE_TAG CLICKHOUSE_AUTO_IMPORT_IMAGE_TAG LITESTREAM_IMAGE_TAG; do
  ./tools/set-image-tag "$var" latest
done
./tools/changelog-add-unreleased

git add src/version.ts docker-compose.yaml CHANGELOG.md
git commit -m "chore: begin development of release <N+1> (PE-####)"
git push origin develop
```
