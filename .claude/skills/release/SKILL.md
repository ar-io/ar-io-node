---
name: release
description: Drive the AR.IO Node release process end-to-end — preflight checks, prepare commit, finalize with image SHAs, test docker compose profiles, tag & publish, and post-release cleanup. Use when the user says "cut a release", "prepare release N", "finalize the release", or similar.
---

# AR.IO Node Release

You are driving a multi-phase release process. Each phase ends in a git commit.
The narrow tools under `tools/` handle file mutations; you handle orchestration,
commits, and interpretation.

## Phases at a glance

1. **Preflight** — confirm the repo is ready to start.
2. **Prepare** — flip version to `N`, set release date in CHANGELOG, commit.
3. **Finalize** — wait for image builds, pin image SHAs in docker-compose, commit.
4. **Test** — bring up each docker compose profile, verify stability.
5. **Tag & publish** — git tag, push, create GitHub release.
6. **Merge to main** — merge `develop` into `main` through a PR.
7. **Post-release** — bump to `N+1-pre`, reset image tags to `latest`, add new
   `[Unreleased]` changelog section, commit.

Work one phase at a time. Stop and confirm with the user before phases with
external side effects: tag push, GitHub release creation, merge to main.

Run the release from a dedicated worktree with `develop` checked out (for
example `git worktree add ../node-wt-release develop`), never from a directory
a live gateway runs its compose stack from: Phase 4 runs `docker compose down`,
and the release tools edit `docker-compose.yaml`. The tools need Node 20
(`nvm use`); under Node 16 they fail with `bad option: --import`.

## Phase 1 — Preflight

Run: `./tools/release-info --json`

Also check:

- `git rev-parse --abbrev-ref HEAD` — must be `develop`
- `git status --porcelain` — must be empty (clean working tree)
- `yarn audit` — review output. For each high or critical advisory, check
  whether it is reachable at runtime (trace the dependency path with
  `yarn audit --json`) and whether it is new since the last release. Stop for
  the user only on one that is reachable or new; report the rest.

From `release-info` output, verify:

- `versionIsPre === true` (e.g., `"53-pre"`)
- `arIoNodeRelease` matches `version`
- `changelogUnreleasedHasContent === true`
- All `RELEASE_MANAGED_IMAGE_VARS` (ENVOY, CORE, CLICKHOUSE_AUTO_IMPORT,
  LITESTREAM) are `"latest"`
- `OBSERVER_IMAGE_TAG` is a pinned 40-char SHA (not `"latest"`)

### Changelog coverage check

`changelogUnreleasedHasContent` only confirms the `[Unreleased]` section is
non-empty. Before proceeding, also verify that user-visible changes merged
since the last release are actually reflected in that section.

1. Identify the previous release tag (e.g., `r75`):

   ```bash
   git describe --tags --abbrev=0 --match 'r*'
   ```

2. List commits merged to `develop` since that tag:

   ```bash
   git log --no-merges --pretty='%h %s' r<N-1>..develop
   ```

3. Read the `[Unreleased]` section of `CHANGELOG.md` and compare. Flag any
   commit that looks user-visible (feat, fix affecting users, behavior
   change, new/changed env var, API change, perf) but is **not** represented
   by an entry.

**Do not flag:**

- Commits that fix or revise something *also introduced in this release
  cycle* (e.g., a `feat:` and a follow-up `fix:` for the same feature
  within `r<N-1>..develop`). The net user-visible change is one entry for
  the feature; intermediate fixes are implementation churn.
- Pure `chore:`, `refactor:`, `test:`, `docs:`, CI/tooling, or dependency
  bumps with no user-visible effect.

Report any gaps to the user and pause for them to either add entries or
confirm the omission is intentional before continuing.

The release number to use is `version.replace('-pre', '')`. Confirm with the
user before proceeding.

## Phase 2 — Prepare

Mutations (run in order):

```bash
./tools/changelog-release <N>          # defaults --date to today
./tools/set-version <N>
./tools/set-ar-io-node-release <N>
```

### Summary blurb

`changelog-release` renames the section heading but does **not** add a summary
paragraph. Immediately under the new `## [Release N] - <date>` heading, write
a 1-paragraph summary in the style of prior releases (see `[Release 74]` and
`[Release 75]`): open with "This is a **recommended release** focused on
**<2–3 themes>**." and then enumerate "Key highlights include…" across the
most impactful entries in Added/Changed/Fixed. Verify the paragraph is
present before committing.

Commit:

```bash
git add CHANGELOG.md src/version.ts docker-compose.yaml
git commit -m "chore: prepare release <N>"
git push origin develop
```

This push triggers image builds on GitHub Actions. Move on once pushed.

## Phase 3 — Finalize

Wait for builds to complete:

```bash
gh api repos/ar-io/ar-io-node/actions/runs \
  --jq '.workflow_runs[] | select(.status == "in_progress" or .status == "queued") | .id' \
  | wc -l
```

When the count is `0`, proceed. (Poll at ~2 minute intervals if needed; don't
tight-loop.)

Fetch and apply SHAs for each release-managed image:

```bash
for image in ar-io-envoy ar-io-core ar-io-clickhouse-auto-import ar-io-litestream; do
  sha=$(gh api "/orgs/ar-io/packages/container/${image}/versions" \
    --jq '.[0].metadata.container.tags[] | select(. != "latest")' | head -1)
  echo "${image}: ${sha}"
  git rev-parse --verify "$sha" || { echo "SHA not in git history!"; exit 1; }
done
```

The packages API needs the `read:packages` scope (`gh auth refresh -s
read:packages`). Without it, take each SHA from the image workflow's last
successful run on `develop`. Each workflow tags its image with the commit
that triggered the run (`github.sha`), so that run's head SHA is the newest
published tag, and a failed or skipped build cannot yield a SHA with no image:

```bash
for wf in build-envoy build-clickhouse-auto-import build-litestream; do
  echo "$wf: $(gh run list --workflow "$wf.yml" --branch develop --status success \
    --limit 1 --json headSha -q '.[0].headSha')"
done
```

Run history expires. A workflow that has not built for a long time lists no
runs (litestream's image dates from 2024). Then keep the previous release's
pin, after checking nothing under that workflow's `paths:` changed since:

```bash
git show r<N-1>:docker-compose.yaml | grep 'ar-io-litestream:'
git log --oneline r<N-1>..develop -- litestream/          # must print nothing
```

The paths each workflow builds on, for that check:

| Workflow | Paths |
| --- | --- |
| `build-envoy` | `envoy/` |
| `build-litestream` | `litestream/` |
| `build-clickhouse-auto-import` | `Dockerfile.clickhouse-auto-import scripts/clickhouse-auto-import scripts/clickhouse-import scripts/parquet-export scripts/lib/common.sh src/database/clickhouse/ src/database/duckdb/ src/workers/parquet-exporter.ts src/database/composite-clickhouse.ts` |

So a ClickHouse schema change moves `ar-io-clickhouse-auto-import` as well as
core. `ar-io-core` is the commit being released (the head of `develop`, after
any last merges). Whatever the source, confirm every SHA is published before
pinning it:

```bash
docker manifest inspect ghcr.io/ar-io/<image>:<sha> >/dev/null && echo ok
```

If a change lands on `develop` after the prepare commit and belongs in the
release, merge it, wait for its build, and pin that core image instead; the
prepare commit does not need redoing.

Map image name → env var:

| Image                            | Env var                             |
| -------------------------------- | ----------------------------------- |
| `ar-io-envoy`                    | `ENVOY_IMAGE_TAG`                   |
| `ar-io-core`                     | `CORE_IMAGE_TAG`                    |
| `ar-io-clickhouse-auto-import`   | `CLICKHOUSE_AUTO_IMPORT_IMAGE_TAG`  |
| `ar-io-litestream`               | `LITESTREAM_IMAGE_TAG`              |

Then for each pair:

```bash
./tools/set-image-tag <ENV_VAR> <sha>
```

The observer image stays pinned — do not touch it.

Commit:

```bash
git add docker-compose.yaml
git commit -m "chore: finalize release <N> with image SHAs"
git push origin develop
```

## Phase 4 — Test

Ensure Docker is available: `docker info >/dev/null`.

Test each profile. Between profiles, always run the `down-all` cleanup:

```bash
docker compose --profile clickhouse --profile litestream --profile otel down
```

Core containers expected to stay running across every profile: `envoy`, `core`,
`redis`, `observer`. Check with:

```bash
docker ps --format '{{.Names}}'
```

### Profile matrix

| Profile    | Up command                                                            | Expected running            | Expected present (may exit)       | Stabilization |
| ---------- | --------------------------------------------------------------------- | --------------------------- | --------------------------------- | ------------- |
| default    | `docker compose up -d`                                                | core                        | —                                 | 30s + 15s recheck |
| clickhouse | `docker compose --profile clickhouse up -d`                           | core + `clickhouse`, `clickhouse-auto-import` | —               | 45s           |
| litestream | `docker compose --profile litestream up -d`                           | core                        | `litestream` (may exit if no S3)  | 30s           |
| otel       | `docker compose --profile otel up -d`                                 | core                        | `otel-collector` (may exit if no endpoint) | 30s  |

For the default profile: after 30s, confirm core containers are up; after
another 15s, confirm they're **still** up (catches restart loops).

Use `docker ps -a --format '{{.Names}}'` to check "present but exited"
containers. Report each profile's outcome back to the user before moving on.

Final cleanup: run the `down-all` cleanup above.

**On a host that runs a live gateway**, never run these from that gateway's
compose directory: `down` there stops production. Either:

- test the default and clickhouse profiles by moving the live gateway onto the
  release image (`CORE_IMAGE_TAG` and, if it changed, `ENVOY_IMAGE_TAG` in its
  `.env`, then recreate with its own `-f` files), and check health, logs and
  requests through every layer; and
- start the remaining profiles' services in an isolated project from the
  release worktree, which cannot touch the live containers:

  ```bash
  docker compose -p r<N>-profile-test --profile litestream --profile otel \
    up -d --no-deps litestream otel-collector
  docker compose -p r<N>-profile-test --profile litestream --profile otel down
  ```

## Phase 5 — Tag & publish

**Pause and confirm with user before this phase.**

```bash
git tag r<N>
git push origin r<N>
```

Draft release notes from the `[Release N]` section of `CHANGELOG.md` plus the
image SHA list from `release-info`. **Unwrap the hard-wrapped lines** before
publishing — the CHANGELOG hard-wraps at ~70 chars, which GitHub Markdown
renders as visual line breaks in the release UI's narrow column. Join lines
within each block (paragraph or bullet) into a single logical line; preserve
blank lines between blocks and heading lines as-is.

**Link each image SHA** to its GHCR package version page so readers can
inspect the exact image (without `read:packages`, link the package page,
`https://github.com/orgs/ar-io/packages/container/package/<image>`, as r83 and
r84 did). Resolve the HTML URL via:

```bash
gh api "/orgs/ar-io/packages/container/<image>/versions" \
  --jq '.[] | select(.metadata.container.tags[] | contains("<sha>")) | .html_url' | head -1
```

Then format the entry as:

```markdown
- `CORE_IMAGE_TAG`: [`<sha>`](https://github.com/orgs/ar-io/packages/container/ar-io-core/<version-id>)
```

Include `OBSERVER_IMAGE_TAG` (resolve via the `ar-io-observer` package) even
though it's not release-managed — operators still want the link.

Example reformatter (run against the extracted Release N section). It joins
the wrapped lines of each paragraph or list item, keeps every list item
(nested ones included) on its own line, and copies fenced code blocks
verbatim, blank lines included:

```python
import re, sys
out, current, fenced = [], None, False
def flush():
    global current
    if current is not None:
        out.append(current)
        current = None
for line in sys.stdin.read().rstrip().splitlines():
    if line.strip().startswith('```'):
        flush()
        out.append(line.rstrip())
        fenced = not fenced
    elif fenced:
        out.append(line.rstrip())
    elif not line.strip():
        flush()
        out.append('')
    elif line.lstrip().startswith('#') or re.match(r'^\s*[-*] ', line):
        flush()
        current = line.rstrip()
    elif current is None:
        current = line.rstrip()
    else:
        current += ' ' + line.strip()
flush()
print('\n'.join(out))
```

Then:

```bash
gh release create r<N> \
  --title "Release <N>" \
  --notes-file <path-to-notes>
```

Pushing the `r<N>` tag triggers another round of image builds that publish
the `r<N>`-tagged container images. **Wait for those builds to finish**
before moving to Phase 6 — operators pulling `r<N>` need the tagged images
available. Poll with the same `gh api .../actions/runs` query as Phase 3 at
~2 minute intervals.

## Phase 6 — Merge to main

**Pause and confirm with user before this phase.** `main` carries the merge
commits of earlier promotions, so it cannot fast-forward to `develop`. Promote
through a PR titled `Release <N> → main` (see #877 and #960 for the body: tag,
pinned images, what was tested), check it has no conflicts, and merge it with
a merge commit:

```bash
gh pr create --base main --head develop --title "Release <N> → main" --body-file <notes>
gh pr merge <PR> --merge
git fetch origin && git diff --quiet r<N> origin/main && echo "main matches r<N>"
```

## Phase 7 — Post-release

```bash
./tools/set-version <N+1>-pre
./tools/set-ar-io-node-release <N+1>-pre
for var in ENVOY_IMAGE_TAG CORE_IMAGE_TAG CLICKHOUSE_AUTO_IMPORT_IMAGE_TAG LITESTREAM_IMAGE_TAG; do
  ./tools/set-image-tag "$var" latest
done
./tools/changelog-add-unreleased
```

The observer image stays pinned — don't reset it.

Commit:

```bash
git add src/version.ts docker-compose.yaml CHANGELOG.md
git commit -m "chore: begin development of release <N+1>"
git push origin develop
```

## Image-tag policy

| Env var                             | Release-managed? | Behavior                                |
| ----------------------------------- | ---------------- | --------------------------------------- |
| `ENVOY_IMAGE_TAG`                   | yes              | SHA at finalize → `latest` at post      |
| `CORE_IMAGE_TAG`                    | yes              | SHA at finalize → `latest` at post      |
| `CLICKHOUSE_AUTO_IMPORT_IMAGE_TAG`  | yes              | SHA at finalize → `latest` at post      |
| `LITESTREAM_IMAGE_TAG`              | yes              | SHA at finalize → `latest` at post      |
| `OBSERVER_IMAGE_TAG`                | no               | stays pinned; only bump intentionally   |

## Failure recovery

Before a phase's commit, mutations are local. To undo:

```bash
git checkout -- CHANGELOG.md src/version.ts docker-compose.yaml
```

If you've committed but not pushed, reset:

```bash
git reset --hard HEAD~1     # ask user first
```

**Never force-push `develop` or `main`.** If a pushed commit needs to be
undone, ask the user how to proceed (likely a forward-fixing commit).

## Conventions

- Commit message format: `chore: <phase summary>`. The project no longer uses
  Jira; do not add `PE-####` references.
- `develop` requires a review for PRs but not for admins, so the release
  commits pushed directly bypass it. Say so to the user.
- Prefer `./tools/release-info --json` for programmatic state checks.
- Each narrow tool is idempotent where possible — a no-op message is fine.
