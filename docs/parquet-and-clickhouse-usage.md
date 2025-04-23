# Overview

Release 33 and greater have experimental support for both exporting Parquet
files from the SQLite DBs maintained by the gateway and importing those files
into ClickHouse. ClickHouse's high-performance query engine and advanced data
compression allow gateways to handle larger data sets while the use of Parquet
supports sharing indexing work across gateways by reusing their outputs in the
form of Parquet files.

> [!NOTE]
> This guide assumes you are using Docker Compose on Linux. Other OSes and
> container orchestration tools can be made to work as well, but are not
> covered in this document.

# Usage

Below is an example of how to configure your gateway to serve a complete
historical ArDrive index and index new ArDrive bundles on an ongoing basis.

> [!NOTE]
> While we currently only offer ArDrive Parquet snapshots, we are
> interested in hearing from users about what other data sets would be useful
> and may provide more options in the future.

## Configure the ar-io-node

In order to perform the initial import and ongoing export of bundle data items
to ClickHouse, configure the gateway with an admin password, ClickHouse
password, and bundle indexing filters.

Place the following `.env` in the root ar-io-node directory:
```sh
#ADMIN_API_KEY=<example> # CHANGE THIS VALUE AND UNCOMMENT!
#CLICKHOUSE_PASSWORD=<example> # CHANGE THIS VALUE AND UNCOMMENT!
CLICKHOUSE_URL="http://clickhouse:8123"
ANS104_UNBUNDLE_FILTER='{ "and": [ { "not": { "or": [ { "tags": [ { "name": "Bundler-App-Name", "value": "Warp" } ] }, { "tags": [ { "name": "Bundler-App-Name", "value": "Redstone" } ] }, { "tags": [ { "name": "Bundler-App-Name", "value": "KYVE" } ] }, { "tags": [ { "name": "Bundler-App-Name", "value": "AO" } ] }, { "attributes": { "owner_address": "-OXcT1sVRSA5eGwt2k6Yuz8-3e3g9WJi5uSE99CWqsBs" } }, { "attributes": { "owner_address": "ZE0N-8P9gXkhtK-07PQu9d8me5tGDxa_i4Mee5RzVYg" } }, { "attributes": { "owner_address": "6DTqSgzXVErOuLhaP0fmAjqF4yzXkvth58asTxP3pNw" } } ] } }, { "tags": [ { "name": "App-Name", "valueStartsWith": "ArDrive" } ] } ] }'
ANS104_INDEX_FILTER='{ "tags": [ { "name": "App-Name", "value": "ArDrive-App" } ] }'
```

## Download and import the Parquet

Run the following in the ar-io-node root directory:

```sh
curl -L https://arweave.net/JVmsuD2EmFkhitzWN71oi9woADE4WUfvrbBYgremCBM -o 2025-04-23-ardrive-ans104-parquet.tar.gz
tar -xzf 2025-04-23-ardrive-ans104-parquet.tar.gz
mv 2025-04-23-ardrive-ans104-parquet/* data/parquet
docker compose --profile clickhouse up clickhouse -d
./scripts/clickhouse-import
docker compose --profile clickhouse down
```

The import process should take 10 - 20 minutes depending on your hardware and
will log progress as it proceeds. One completed, if you have the ClickHouse
client installed, you can confirm the data was successfully imported with the
following command:

```sh
clickhouse client --password <your-password> -h localhost -q 'SELECT COUNT(DISTINCT id) FROM transactions'
```

The query will take a second or two to run and should output `32712311`.

## Download and move the SQLite DB snapshot

The Arweave base layer SQLite DB snapshots are significantly larger than the
Parquet files and not as easy to incrementally update, so we distribute them
using BitTorrent. You can download them using the torrent client of your
choice. Below is an example of doing this using Transmission:

```sh
transmission-cli "magnet:?xt=urn:btih:62ca6e05248e6df59fac9e38252e9c71951294ed&dn=2025-04-23-sqlite.tar.gz&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=http%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.demonii.com%3A1337%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=udp%3A%2F%2Fp4p.arenabg.com%3A1337%2Fannounce&tr=https%3A%2F%2Ftracker.bt4g.com%3A443%2Fannounce"
```

Once you have a copy of the SQLite DB snapshot, run the commands below in the
ar-io-node root directory.

> [!WARNING]
> This will erase your existing SQLite DB. Be sure to create a copy first if
> you'd like to preserve it.

```sh
tar -xzf 2025-04-23-sqlite.tar.gz
rm data/sqlite/*
mv 2025-04-23-sqlite/* data/sqlite
```

## Start the ar-io-node

```sh
docker compose --profile clickhouse up -d
```

This will start the ar-io-node with ClickHouse and automatically export
data items to ClickHouse after they are unbundled.

## Run a GraphQL with ClickHouse

The following GraphQL query will verify that ClickHouse is working as expected
by retreiving a data item imported from Parquet:

```sh
curl -g -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"query { transactions(ids: [\"YSNwoYB01EFIzbs6HmkGUjjxHW3xuqh-rckYhi0av4A\"]) { edges { node { block { height } bundledIn { id } } } } }"}' \
  http://localhost:3000/graphql

# Expected output:
# {"data":{"transactions":{"edges":[{"node":{"block":{"height":1461918},"bundledIn":{"id":"ylhb0PqDtG5HwBg00_RYztUl0x2RuKvbNzT6YiNR2JA"}}}]}}}
```

