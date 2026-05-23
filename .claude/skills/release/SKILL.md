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
6. **Merge to main** — fast-forward `main` to the release commit.
7. **Post-release** — bump to `N+1-pre`, reset image tags to `latest`, add new
   `[Unreleased]` changelog section, commit.

Work one phase at a time. Stop and confirm with the user before phases with
external side effects: tag push, GitHub release creation, merge to main.

## Phase 1 — Preflight

Run: `./tools/release-info --json`

Also check:

- `git rev-parse --abbrev-ref HEAD` — must be `develop`
- `git status --porcelain` — must be empty (clean working tree)
- `yarn audit` — review output; bail if high-severity vulnerabilities surface

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

Find the Jira ticket for the release (search Jira or recent git log for a
`PE-####` referencing "Release N"). If none is found, ask the user.

Commit:

```bash
git add CHANGELOG.md src/version.ts docker-compose.yaml
git commit -m "chore: prepare release <N> (PE-####)"
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

Observer and AO CU images stay pinned — do not touch them.

Commit:

```bash
git add docker-compose.yaml
git commit -m "chore: finalize release <N> with image SHAs (PE-####)"
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
inspect the exact image. Resolve the HTML URL via:

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

Example reformatter (run against the extracted Release N section):

```python
import re, sys
text = sys.stdin.read()
blocks = re.split(r'\n[ \t]*\n', text.rstrip())
for b in blocks:
    lines = b.splitlines()
    if lines and lines[0].lstrip().startswith('#'):
        print('\n'.join(lines))
    else:
        print(' '.join(l.strip() for l in lines if l.strip()))
    print()
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

**Pause and confirm with user before this phase.** Typical flow (adjust if
the project uses PRs-to-main):

```bash
git checkout main
git pull
git merge --ff-only develop
git push origin main
git checkout develop
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

Observer and AO CU stay pinned — don't reset them.

Commit:

```bash
git add src/version.ts docker-compose.yaml CHANGELOG.md
git commit -m "chore: begin development of release <N+1> (PE-####)"
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

- Commit message format: `chore: <phase summary> (PE-####)`.
- Find the Jira ref via `git log -20 --pretty=%s | grep -oE 'PE-[0-9]+' | head -1`
  or ask the user.
- Prefer `./tools/release-info --json` for programmatic state checks.
- Each narrow tool is idempotent where possible — a no-op message is fine.
