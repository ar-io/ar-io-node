# The `ar-io-node` CLI

`ar-io-node` is the gateway's command-line tool. Its first commands build and
check [index bands](index-swarm.md#producing-bands); every other command is a
command of the `ar.io` CLI from `@ar.io/sdk`, run with the same arguments.

It follows the `ar.io` CLI's conventions, so the two behave alike:

- flat, kebab-case command names (`index-band-build`, `get-gateway`);
- a command's result is printed as indented JSON on **stdout**, with exit code
  `0`;
- an error's message goes to **stderr** (its stack trace with `--debug`), with
  exit code `1`. A check that fails prints its full result, as JSON, on stderr;
- logs go to stderr too, so stdout can be parsed.

If you are a script or an agent, read [For scripts and
agents](#for-scripts-and-agents) first.

## Running it

From the gateway's directory (where `.env` and `docker-compose.yaml` are),
`tools/ar-io-node` runs it in the core image named by `CORE_IMAGE_TAG`, so the
host needs only Docker:

```bash
./tools/ar-io-node --help
./tools/ar-io-node network-help        # the ar.io commands it runs for you
```

The wrapper mounts only what a command needs:

| Commands | Mounted |
| --- | --- |
| `index-band-*` | `INDEX_SWARM_DATA_PATH` (default `./data/indexes`) at `data/indexes`, and the gateway's Docker network (`DOCKER_NETWORK_NAME`, default `ar-io-network`), so `--gateway-url http://core:4000` reaches the gateway |
| any `ar.io` command | Nothing, except the file a `--wallet-file` (`-w`) names, read-only. A relative path is taken from where you ran the wrapper |

It runs as your user, so what it writes is yours, and
`data/indexes/published/<index>` must be writable by you. Ctrl-C stops a
command; a build interrupted that way leaves its scratch copy in
`data/indexes/export/.band-build-*`, which the next build removes once nothing
has been written in it for a day (or delete it yourself).

Band commands never take a key. For `ar.io` commands that sign, prefer
`--wallet-file` to `--private-key`: an inline key is visible in `ps` and
`docker inspect`.

Settings (`CORE_IMAGE_TAG`, `INDEX_SWARM_DATA_PATH`, `DOCKER_NETWORK_NAME`)
come from your shell if set there, else from `.env`, as for compose. Set
`AR_IO_NODE_CLI_IMAGE` to run another image. From a checkout, run
`node --import ./register.js src/cli/cli.ts <command>`.

### Paths

Inside the container, the data directory is `data/indexes`. The wrapper
rewrites any `--input`, `--band-dir`, `--publish-dir` or `--work-dir` that
points inside `INDEX_SWARM_DATA_PATH` (absolute, or relative to where you ran
it) to its `data/indexes/...` form, so all of these work:

```bash
./tools/ar-io-node index-band-verify --band-dir "$INDEX_SWARM_DATA_PATH/published/root-tx-index/<band>" ...
./tools/ar-io-node index-band-verify --band-dir data/indexes/published/root-tx-index/<band> ...
./tools/ar-io-node index-band-verify --band-dir "$(jq -r .dir build.json)" ...   # a build's own "dir"
```

A path outside the data directory is passed through unchanged, and a band
command refuses to write there (it would land inside the container and be
lost). An input file elsewhere goes in on stdin: `--input - < records.csv`.
The `dir` a build reports is the container path (`data/indexes/...`).

## `index-band-build`

Builds one band from CSV records, checks a sample of its headers against
their root transactions, and publishes it:

```bash
./tools/ar-io-node index-band-build --input - --skip-header \
  --publisher <this gateway's wallet> --kind d --height-range 2010500,tip \
  --gateway-url https://turbo-gateway.com < records.csv
```

The band is built under `--work-dir` and renamed into `--publish-dir`, where
the index-swarm sidecar publishes it. Both must be on one filesystem (the
defaults are). An existing band is never overwritten: building the same
records again reports `"unchanged": true`, without checking or writing.

**Input:** CSV in the columns of `tools/generate-cdb64-root-tx-index`, plus a
height:

```text
data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size,height
```

- Only the first two columns are required. `path` must be empty: bands don't
  carry nested bundle paths yet.
- When one ID appears more than once, the highest `height` wins; at equal
  heights a record with offsets beats one without, and any remaining tie is
  broken the same way whatever the input order, so a rebuild gives the same
  band id.
- A malformed row (an ID that isn't 43 base64url characters, a number that
  isn't a non-negative integer) fails the build with its line number.
- A well-formed record the band can't use is **dropped and counted**: offsets
  that don't frame a header (the header span must be 1 byte to 1 MiB), only
  one of the two offsets, or a value too large to address. A few per thousand
  is normal for real data (37 of 4,000 in the test below); the build logs a
  warning with the count.

| Option | Meaning |
| --- | --- |
| `--input <path>` | The CSV, or `-` for stdin. Required |
| `--skip-header` | Skip the CSV's first line |
| `--publisher <wallet>` | The publishing gateway's registered wallet. It names the band (so ids are unique to a publisher) and is not otherwise checked. Required |
| `--kind <kind>` | `d` (delta), `r` (recent), `h` (history), or another name of up to 8 lowercase letters and digits. Required |
| `--height-range <from,to>` | The heights the band covers, e.g. `2010500,tip`; `tip` for a band that follows the tip. It is declared in the band's metadata (subscribers use it to order installs); records are not filtered by it. Required |
| `--supersedes <ids>` | Comma-separated ids of bands this one replaces. Not checked against what exists: the sidecar stops offering the named bands and deletes them after `INDEX_SWARM_SUPERSEDE_GRACE_SECONDS`, and warns once about an id it doesn't hold (see [band metadata](index-swarm.md#band-metadata)) |
| `--metadata <json>` | A JSON object of extra band metadata |
| `--publish-dir <path>` | Where the band is published, one directory per band (default `data/indexes/published/root-tx-index`) |
| `--work-dir <path>` | Scratch space for the build (default `data/indexes/export`) |
| `--gateway-url <url>` | The gateway the header check reads root transactions from. Required unless `--skip-header-check`. See [Choosing `--gateway-url`](#choosing---gateway-url) |
| `--read-timeout <ms>` | How long the check waits for each root read (default 30000) |
| `--skip-header-check` | Publish without the header check |
| `--sample-size <n>` | Entries the check samples (default 150) |
| `--dry-run` | Build and check, but publish nothing |

**The header check** samples entries with offsets and range-reads each one's
root transaction. A band fails if any header is wrong (its signature hash
isn't the ID, or it doesn't end where the payload starts, or the offsets run
past the end of the root), if fewer than 80% of the sample could be read and
passed, or if the band has fewer than 1,000 entries. A failed band is not
published, and the command exits 1 with the result on stderr. A band can pass
with a few entries the gateway couldn't serve: they are listed in `errors`
and count against the 80%, but aren't evidence the band is wrong.

## `index-band-verify`

Runs the header check on a built or installed band:

```bash
./tools/ar-io-node index-band-verify \
  --band-dir data/indexes/published/root-tx-index/<band> \
  --gateway-url https://turbo-gateway.com
```

| Option | Meaning |
| --- | --- |
| `--band-dir <path>` | The band's directory (it holds `manifest.json`). Required |
| `--gateway-url <url>` | As for `index-band-build`. Required |
| `--read-timeout <ms>` | As for `index-band-build` (default 30000) |
| `--sample-size <n>` | Entries to check (default 150) |

It prints the result and exits 1 if the band fails.

## For scripts and agents

Every `ar-io-node` command is non-interactive and answers in one shape, so a
script or an agent can drive it without parsing prose.

### The contract

| | Success | Failure |
| --- | --- | --- |
| Exit code | `0` | `1` (`130` when interrupted with Ctrl-C) |
| stdout | Exactly one JSON value, the command's result | Empty |
| stderr | Log lines (`info:`, `warn:`) only | Log lines, then either one line of error text, or (for a band refused by the header check, or a failed verify) the result as JSON |

- **Read stdout, branch on the exit code.** Never parse stderr for success;
  log lines may change.
- `--help`, `--version` and `network-help` print text, not JSON. Each
  command's `--help` ends with an example and this contract. `--version`
  prints the `@ar.io/sdk` version the `ar.io` commands run.
- **No prompts.** Band commands never ask for confirmation and never take a
  key. (`ar.io` commands that write do prompt unless given
  `--skip-confirmation`; see their help.)
- **Safe to retry.** A band's id is derived from its content, publisher,
  kind and heights, so building the same records again gives the same id and
  reports `"unchanged": true` without checking or writing. A build that fails
  or is interrupted publishes nothing.
- **Paths:** pass the `dir` a build reports straight back as `--band-dir`;
  see [Paths](#paths).
- **No network** except range reads of root transactions from
  `--gateway-url` during the header check. Band commands make no Solana RPC
  calls.

### `index-band-build` result

From a real run (4,000 records from a gateway's own index, checked against
turbo-gateway.com):

```json
{
  "id": "d-h2000000-tip-f5b1208c-0dac038f25bc",
  "dir": "data/indexes/published/root-tx-index/d-h2000000-tip-f5b1208c-0dac038f25bc",
  "published": true,
  "unchanged": false,
  "dryRun": false,
  "records": 3963,
  "rootOnly": 0,
  "duplicates": 0,
  "dropped": 37,
  "sizeDropped": 0,
  "heightRange": [2000000, null],
  "supersedes": [],
  "contentDigest": "…",
  "headerCheck": {
    "status": "passed",
    "passed": true,
    "reasons": [],
    "totalRecords": 3963,
    "checked": 150,
    "ok": 149,
    "wrong": [],
    "errors": [{ "id": "…", "error": "timeout of 30000ms exceeded" }]
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | The band's id |
| `dir` | Where the band is, as a container path; `null` on a dry run of a band not already published |
| `published` / `unchanged` | `published` when this run published it; `unchanged` when an identical band was already there. **The band is in place when either is true** |
| `records` | Entries written. `rootOnly` of them have no offsets; `duplicates` lost to a better record for the same ID |
| `dropped` / `sizeDropped` | Records refused as invalid (normal in small numbers), and records whose size was dropped while their offsets were kept |
| `headerCheck.status` | Always present: `passed`, `failed`, `already-published` (an identical band was there; nothing was checked) or `skipped` (`--skip-header-check`). The other fields are present only when the check ran |

A band the check refuses exits `1` and prints this object on stderr, with
`published: false`, `headerCheck.status: "failed"` and a `rejected` array of
reasons.

### `index-band-verify` result

`{ "bandDir", "passed", "reasons", "totalRecords", "checked", "ok", "wrong", "errors" }`.
`wrong` lists entries whose header doesn't match (`id`, `reason`); `errors`
lists entries the gateway couldn't serve (`id`, `error`), which count against
the 80% pass ratio but are not evidence the band is wrong. Exit `1`, with the
object on stderr, when `passed` is false.

### Example

```bash
if out=$(./tools/ar-io-node index-band-build --input - --skip-header \
    --publisher "$WALLET" --kind d --height-range "$FROM,tip" \
    --gateway-url https://turbo-gateway.com < records.csv); then
  dir=$(jq -r .dir <<<"$out")              # in place: .published or .unchanged
  ./tools/ar-io-node index-band-verify --band-dir "$dir" \
    --gateway-url https://turbo-gateway.com >/dev/null
else
  echo "band refused or failed; see stderr" >&2
fi
```

### Choosing `--gateway-url`

The check range-reads up to 150 root transactions. A gateway that has to
fetch them from the network itself can time out on many of them, and the
band is then refused for being under 80% checked, not for being wrong (the
reason says how many couldn't be read, and why). Use a gateway that already
holds the roots, typically the one whose index produced the records, or
`https://turbo-gateway.com`; or raise `--read-timeout`. Measured on
2026-10-01 with 4,000 recent records on a gateway without those roots cached:

| `--gateway-url` | `--read-timeout` | Result | Time |
| --- | --- | --- | --- |
| `http://core:4000` | 30 s (default) | Refused: 108 of 150 passed, 42 reads timed out | 3 min 47 s |
| `http://core:4000` | 120 s | Passed: 149 of 150 | 7 min 8 s |
| `https://turbo-gateway.com` | 30 s (default) | Passed: 149 of 150 | 40 s |

### Errors and what to do

| stderr says | Cause | Fix |
| --- | --- | --- |
| `--input is required` (or `--publisher`, `--kind`, `--height-range`, `--band-dir`) | A required option is missing | Pass it |
| `error: unknown option '--x'` | A misspelt or unsupported option | Check `--help` |
| `--gateway-url is required unless --skip-header-check` | No gateway for the check | Pass `--gateway-url`, or `--skip-header-check` to publish unchecked |
| `--input X cannot be read; through tools/ar-io-node, pipe it on stdin …` | The file isn't there, or is outside the data directory | `--input - < X`, or put X under `INDEX_SWARM_DATA_PATH` |
| `--band-dir X is not a band (no manifest.json)` | Not a band directory, or outside the data directory | Use a path under `INDEX_SWARM_DATA_PATH`, or a build's `dir` |
| `Line N: data_item_id is not a 43-character ID (a header line? use --skip-header)` | A header line, or a malformed ID | `--skip-header`, or fix line N |
| `Line N: nested bundle paths are not supported in bands yet` | The `path` column is set | Leave it empty |
| `Invalid --height-range: …` | Not `<from>,<to>` or `<from>,tip`, or `to` below `from` | Fix the range |
| `Invalid sample-size: …` (or `read-timeout`) | Not a positive integer | Fix the value |
| `--metadata is not valid JSON` (or `must be a JSON object`) | | Pass a JSON object |
| `--publish-dir … is outside data/indexes …` (or `--work-dir`) | Through the wrapper, only the data directory is mounted | Use a directory under it |
| `… checked entries passed, under 80%; N could not be read …` | The gateway couldn't serve enough roots | See [Choosing `--gateway-url`](#choosing---gateway-url) |
| `N of M checked entries are wrong` | Offsets that don't point at the item's header | Fix the source of the records; don't publish |
| `… exists but is not a band …` | Something else is at the band's path | Remove it |
| `workDir … and publishDir … must be on the same filesystem` | The final rename can't cross filesystems | Put both under one mount (the defaults are) |
| `ar-io-node: … predates this tool` | `CORE_IMAGE_TAG` names an image without the CLI | Upgrade, or set `AR_IO_NODE_CLI_IMAGE` |

## `ar.io` commands

Any command `ar-io-node` doesn't own runs as the `ar.io` CLI of the
`@ar.io/sdk` the gateway depends on (`ar-io-node --version` shows which), with
the same arguments, output and exit code:

```bash
./tools/ar-io-node get-gateway --address <wallet>
./tools/ar-io-node help get-gateway     # that command's help
./tools/ar-io-node network-help
```

They are the SDK's commands, unchanged: they use the SDK's own network
defaults and flags (`--mainnet`, `--rpc-url` and the program-id options), not
the gateway's settings, and the gateway itself never runs them. Check a
command's help for which network it targets and what it needs.
