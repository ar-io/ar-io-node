# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## 1.0.0 (2024-02-07)


### Features

* add support for uploading observer reports PE-4797 ([0c7fa42](https://github.com/ar-io/ar-io-node/commit/0c7fa42769e5aafaccb6cfafba92f8fed53e9bfe))
* added listener for index matching filter, added shutdown process ([25ef480](https://github.com/ar-io/ar-io-node/commit/25ef480f64704263e415c23c051143ad2a84da84))
* Added simple webhook worker and updated env variables ([52b1eac](https://github.com/ar-io/ar-io-node/commit/52b1eac5c27d738748ce23eee80d3ae20553396c))
* **ans-104:** add an independent data download worker for ANS-104 bundles PE-5192 ([decf33e](https://github.com/ar-io/ar-io-node/commit/decf33e319e666a6509a85ec40c758350f290864))
* **ans-104:** add support for 0 ans-104 worker count ([c5fd9e5](https://github.com/ar-io/ar-io-node/commit/c5fd9e575eb55bfbe42ca94ba382b7065164a8a7))
* **ans-104:** add support for parallel unbundling PE-4903 ([811c31f](https://github.com/ar-io/ar-io-node/commit/811c31ffb8e03bb6732c295dab36966d5cde01f6))
* **ans-104:** disable unbundling workers if filter is '{ "never": true }' ([735c29b](https://github.com/ar-io/ar-io-node/commit/735c29b1acc451e40d1445e80782c9bbbd3c3dcf))
* **block-store:** implement `KvBlockStore` and use it with `lmdb` implementation ([0e6d458](https://github.com/ar-io/ar-io-node/commit/0e6d45896d62792b848125a9e9650a4c8c93ed98))
* bump observer version ([4576ef7](https://github.com/ar-io/ar-io-node/commit/4576ef7b4c49dd0c72e585afc8cec122956a87c7))
* **cache:** add filesystem header cache cleanup worker PE-5037 ([7a72c17](https://github.com/ar-io/ar-io-node/commit/7a72c1766ad0a7b43b6fdd510eea563ccbb0e035))
* **chain sqlite:** index stable transaction data offsets PE-2482 ([d0a8f9a](https://github.com/ar-io/ar-io-node/commit/d0a8f9a76100a62920f7f23c33a0a03627edd078))
* **chain-cache:** add environment variable CHAIN_CACHE_TYPE and use it when setting up KvTransactionStore ([c80cc3d](https://github.com/ar-io/ar-io-node/commit/c80cc3d872ceacc2ccc067e939ab36e67d4a528a))
* **data:** make data source priority configurable PE-5123 ([96fe308](https://github.com/ar-io/ar-io-node/commit/96fe308355ae615dcf4c5a9ba683d2d54621d69a))
* **docker:** allow configuration of node GC old gen size PE-4903 ([f1980fa](https://github.com/ar-io/ar-io-node/commit/f1980fadc716d03922cda3d664a73792d5cd827b))
* **docker:** restart containers when they fail PE-5129 ([2809f23](https://github.com/ar-io/ar-io-node/commit/2809f23fe06532fcf2477396dc09d7199ef89d48))
* **docker:** set nodejs max old space size based # of ans-104 workers ([6cfe5bf](https://github.com/ar-io/ar-io-node/commit/6cfe5bfd0bb792a03d039f6f467ea493adff863f))
* **docker:** specify image tags in .env PE-5040 ([1a7501f](https://github.com/ar-io/ar-io-node/commit/1a7501fca652e96b2aafc37ed3520ce279677382))
* **envoy:** route /ar-io/observer to the observer service PE-4797 ([52f39b3](https://github.com/ar-io/ar-io-node/commit/52f39b3f6c33b1fb7a8400baa50fd2a6cbfca828))
* expose X-ArNS-* headers for CORS requests ([ee03255](https://github.com/ar-io/ar-io-node/commit/ee032553ec485cb056cb4285f4953b8dd267865b))
* **filters:** add NegateMatch ([277bb36](https://github.com/ar-io/ar-io-node/commit/277bb366cb11733a95a045025a871bf336d93933))
* **info observer:** advertise the contract ID in use PE-4894 ([4dd26c8](https://github.com/ar-io/ar-io-node/commit/4dd26c8a45481409455068c8acd7fba5e30682ac))
* **kv-block-store:** add `KvBlockStore` that uses `KvBufferStore` for storing block data ([2773376](https://github.com/ar-io/ar-io-node/commit/27733767016d67c0d4ef449d6399dc17906656d1))
* **kv-transaction-store:** setup a KvTransactionStore that uses KvBufferStore and implements PartialJsonTransactionStore ([c3ea32b](https://github.com/ar-io/ar-io-node/commit/c3ea32b362187057b34585231470c924d5365123))
* **kv:** introduce KVBufferStore interface and implement filesystem based KVBufferStore ([7554ea4](https://github.com/ar-io/ar-io-node/commit/7554ea4d3405d83854ba84158b0be20ecaddd010))
* **lmbd:** introduce lmdb, implement LmbdbKvStore ([16c07a6](https://github.com/ar-io/ar-io-node/commit/16c07a69d8b362b18f8312d2452ffe5c5296aff4))
* **lmdb:** enable `compression` and add `commitDelay` on LmdbKVStore ([ac8358b](https://github.com/ar-io/ar-io-node/commit/ac8358b04685a7e4292b05fc3b5b97d28194ae30))
* **observer:** add observer service to docker-compose config PE-4797 ([209ad85](https://github.com/ar-io/ar-io-node/commit/209ad850421c2ee2b4424ee371fce7d37bd48fd2))
* **observer:** bump image to add ARM support PE-4870 ([c3856b3](https://github.com/ar-io/ar-io-node/commit/c3856b3cb67ebae2fb246f5b60325fea0d158eba))
* **observer:** bump observer version to get report compression PE-4991 ([16b2868](https://github.com/ar-io/ar-io-node/commit/16b28682e74cbe1d50a5e7198018a32a70638f5e))
* **observer:** bump version for better missing wallet handing PE-4749 ([8035bb4](https://github.com/ar-io/ar-io-node/commit/8035bb4b5465178f52227f74f753d481f8780d65))
* **observer:** enable observer by default PE-4749 ([0d6b6a8](https://github.com/ar-io/ar-io-node/commit/0d6b6a86a8c96b85ca197d024120826157fa8ebc))
* **observer:** update observer version and enable contract interactions PE-5196 ([5851818](https://github.com/ar-io/ar-io-node/commit/5851818f7b27fd60b0793a3d92176a8f2eadf7fa))
* **redis:** add redis implementation of `KvBufferStore` ([3df8928](https://github.com/ar-io/ar-io-node/commit/3df892805e5adaf67a6139ca26aff9a48e1a0071))
* **redis:** add redis to docker-compose and use it as default `KvBufferStore` ([4c56473](https://github.com/ar-io/ar-io-node/commit/4c564732b705644918e47a677d9c59708ae47146))
* rename OBSERVER_DATA_PATH to REPORTS_DATA_PATH PE-4816 ([1a2dfbf](https://github.com/ar-io/ar-io-node/commit/1a2dfbfd926a88977b33ec889d08d47e73bb0b7e))
* **sandbox:** use https as default protocol for sandboxing ([38eb496](https://github.com/ar-io/ar-io-node/commit/38eb4969a30d229bb52df05a4f0578cce18864ba)), closes [#56](https://github.com/ar-io/ar-io-node/issues/56)
* **server:** add release number to /ar-io/info PE-5040 ([75f0efe](https://github.com/ar-io/ar-io-node/commit/75f0efeec81fed8531c3d4bb2cff80809214daf4))
* set up webhook worker to use global event emitter ([5ef7308](https://github.com/ar-io/ar-io-node/commit/5ef730888447eab0e2edc535ae31047c603c5d08))
* **store:** use original custom FS header stores when FS store is enabled PE-5196 ([8c218cd](https://github.com/ar-io/ar-io-node/commit/8c218cde2835d2da762bcce3c47b65d6ae9bb03c))
* **validation:** use regex to sanity check block hashes ([a8b639b](https://github.com/ar-io/ar-io-node/commit/a8b639b317f2888758aae9faa6a3f76fe9433c18))
* **webhook-emitter:** add webhook emitter index filter ([4117eb7](https://github.com/ar-io/ar-io-node/commit/4117eb7d498eb9ed728eefd4ac4a1acf4d6056f0))
* **webhook-emitter:** emit webhooks to a list of target servers ([c820d0c](https://github.com/ar-io/ar-io-node/commit/c820d0cf8af7760ea417e79501aafb9436b4c71a))
* **webhook-emitter:** implement a webhook queue ([4a47cc5](https://github.com/ar-io/ar-io-node/commit/4a47cc59f3926596dc6ad3d64a04870da5f9577f))
* **webhook-emitter:** validate target server URLs and code cleanup ([06b6d16](https://github.com/ar-io/ar-io-node/commit/06b6d161e5dcf3bbaead5b990d422cfe65ce4c15))


### Bug Fixes

* **ans-104:** ensure that ans-104 streams are destroyed on error PE-5088 ([11bc264](https://github.com/ar-io/ar-io-node/commit/11bc264e5dfd966ae01dd4aedbde24cd7fa93cfa))
* **ans-104:** fix support for 0 workers ([8d66f1f](https://github.com/ar-io/ar-io-node/commit/8d66f1f02a4626d8de009ca95f4ed7c879150f3a))
* **arns:** preserve ArNS TTL based Cache-Control header in data handler ([7ad7f45](https://github.com/ar-io/ar-io-node/commit/7ad7f45678eaadf4d96d95db498ec6ff16b13fbd))
* **arweave-client:** drop poa2 from blocks to reduce cache size PE-5551 ([2dabcfe](https://github.com/ar-io/ar-io-node/commit/2dabcfef90f3f3a46b97775948a1170f19a646c8))
* **config:** path to .env.local to dotenv ([e1c3bcd](https://github.com/ar-io/ar-io-node/commit/e1c3bcd4a70aab6b697a90c03534cc5c90e6e4bf))
* **data chunks:** include full dataroot in chunk prefix ([15d6183](https://github.com/ar-io/ar-io-node/commit/15d6183cc4400cd6f050a1950339f744a74926e9))
* **docker redis:** fix typo in docker-compose PE-4924 ([0fd341b](https://github.com/ar-io/ar-io-node/commit/0fd341b9f4488c0b490399f6626f239ae9dda532))
* **docker-compose:** correct core service image tag PE-5196 ([8e19088](https://github.com/ar-io/ar-io-node/commit/8e19088292f0549ad53710a0a9423df282369685))
* **docker:** add `LMDB_DATA_PATH` volume mount ([a6bd399](https://github.com/ar-io/ar-io-node/commit/a6bd3991cbe135b87475d5ca72eddbe6b2eee6a8))
* **docker:** fix `maxmemory` flag in docker file for redis ([3e32dd7](https://github.com/ar-io/ar-io-node/commit/3e32dd74b574fa6b7f7d0bd72903ee19aec05668))
* **docker:** properly set the default warp cache in docker-compose ([03c4408](https://github.com/ar-io/ar-io-node/commit/03c44088c04c9b166aeda2236e047280395d7b01))
* **docker:** set warp volume under data path ([1b32659](https://github.com/ar-io/ar-io-node/commit/1b32659753713e3bafe07be934485c8b82cbbc33))
* **env:** move image tags out of .env to docker-compose.yaml PE-5198 ([c4238aa](https://github.com/ar-io/ar-io-node/commit/c4238aa1b792329bc166843f709cda0d7f69b13e))
* fixed issue with always true index filter ([8a8e7be](https://github.com/ar-io/ar-io-node/commit/8a8e7be353841bd975ff9fd4a872ba9016d3ab42))
* **gateway-data-source:** use 'Accept-Encoding: identity' for gateway data requests PE-5196 ([8a09989](https://github.com/ar-io/ar-io-node/commit/8a0998978e49e437bbfb93c407d00fcf32a16ca0))
* **graphql sqlite:** correctly paginate TXs with duplicate tags PE-5140 ([7f1759a](https://github.com/ar-io/ar-io-node/commit/7f1759a9b73b06dc2a97a170aa04cd0ce0610853))
* **graphql:** order tags by tag index PE-5115 ([7efe274](https://github.com/ar-io/ar-io-node/commit/7efe274d7e76cf561fe027832669b9c3ede33eb6))
* **kv-store:** remove extra checks in lmdb-kv-store ([fe08a3c](https://github.com/ar-io/ar-io-node/commit/fe08a3cbd61e155df62baa5f1c57aed66e7e9c50))
* **lmdb:** bump lmdb version and remove buffer check ([1097313](https://github.com/ar-io/ar-io-node/commit/109731399477f801fdfdd4eee56937c02b920d88))
* **lmdb:** guarantee returning a buffer from lmdb ([7a17b32](https://github.com/ar-io/ar-io-node/commit/7a17b32546707b40f748a68712b23be379430388))
* **observer:** bump observer to fix cache/referesh timing ([c3e6376](https://github.com/ar-io/ar-io-node/commit/c3e637645bd8e1343faf3f2ddc79a19fafd4c537))
* **observer:** bump the observer image to one that properly syncs state from arns cache ([92b26ab](https://github.com/ar-io/ar-io-node/commit/92b26abd790379f4b0613cf7162a07394642e213))
* **observer:** bump version to fix healthcheck ([9312e59](https://github.com/ar-io/ar-io-node/commit/9312e59722df59eee08747e2a02b681724a1d9e5))
* **observer:** send failed gateway wallets instead of FQDNs ([8a3e74e](https://github.com/ar-io/ar-io-node/commit/8a3e74ec94a36dc1fd89a09613cec7146bf9ff21))
* **observer:** wait for ArNS cache in observer PE-5485 ([56fe5fb](https://github.com/ar-io/ar-io-node/commit/56fe5fbd62e7af1b9cab3c37892301c1b3784dbc))
* **range:** return 416 instead of 200 for multiple range requests PE-4908 ([d81bc52](https://github.com/ar-io/ar-io-node/commit/d81bc52fe46915f467710e74841696a25171d99c))
* **redis:** add `ttl` to all redis keys and by default set it to 8 hours ([1fe0b65](https://github.com/ar-io/ar-io-node/commit/1fe0b65b39b0796240c04ddd3ea617f4201efdad))
* **redis:** add prometheus metric to redis errors, set max memory to 2GiB ([4060728](https://github.com/ar-io/ar-io-node/commit/4060728dcef108e9057dc24e30154b87e898bfca))
* **redis:** update the kv-store defaults in docker vs. app ([528649c](https://github.com/ar-io/ar-io-node/commit/528649c5776716990b6d29c893205545f2630b9f))
* **sqlite debug:** correct typo in debug key ([9a0777b](https://github.com/ar-io/ar-io-node/commit/9a0777bdbd81ebea1215e56c3e37d3a2bc510baf))
* **sqlite graphql:** handle null ids, recipients, and owners PE-5196 ([b161f21](https://github.com/ar-io/ar-io-node/commit/b161f21de1a2d76a87b47e68e111a2ef235a183a))
* **sqlite:** limit the number of SQLite GQL worker threads PE-4903 ([74df706](https://github.com/ar-io/ar-io-node/commit/74df7061d31529cd305b52dfad3ef2f4f08662a0))
* **system:** fix import for kvstore util ([18f01b5](https://github.com/ar-io/ar-io-node/commit/18f01b58e347b3cedcf7c270f9f81a8d46d70aa6))


### Performance Improvements

* **data sqlite:** add data attribute and parent circuit breakers PE-5336 ([602cd82](https://github.com/ar-io/ar-io-node/commit/602cd825ff514564441c549c538cd3abd1bc4f54))
* **data sqlite:** increase data index worker count PE-5336 ([485678d](https://github.com/ar-io/ar-io-node/commit/485678d83f0cd30ee077a8656269dd3f7e5e6028))
* **graphql sqlite:** improve GraphQL performance predictability PE-5299 ([727f239](https://github.com/ar-io/ar-io-node/commit/727f2391ab065b4dbb9e124c1344ca45bcb6cc18))


### Reverts

* **lmdb:** disable compression and simplify parameters passed to LmdbKVStore ([7a6731d](https://github.com/ar-io/ar-io-node/commit/7a6731d4f1d63c5c0b8a9c542a09b9641db0138b))

## [Unreleased]

## [Release 6] - 2024-01-29

### Fixed

- Update observer to improve reliability of contract state synchronization and
  evaluation.

## [Release 5] - 2024-01-25

### Added

- Added transaction offset indexing to support future data retrieval
  capabilities.
- Enabled IPv6 support in Envoy config.
- Added ability to configure observer report generation interval via the
  REPORT_GENERATION_INTERVAL_MS environment variable (intended primarily for
  development and testing).

### Changed

- Updated observer to properly handle FQDN conflicts.
- Renamed most created_at columns to indexed_at for consistency and clarity.

### Fixed

- Updated LMDB version to remove Buffer workaround and fix occassional block
  cache errors.

## [Release 4] - 2024-01-11

### Added

- Added circuit breakers around data index access to reduce impact of DB access
  contention under heavy requests loads.
- Added support for configuring data source priority via the
  ON_DEMAND_RETRIEVAL_ORDER environment variable.
- Updated observer to a version that retrieves epoch start and duration from
  contract state.

### Changed

- Set the Redis max memory eviction policy to `allkeys-lru`.
- Reduced default Redis max memory from 2GB to 256MB.
- Improved predictability and performance of GraphQL queries.
- Eliminated unbundling worker threads when filters are configured to skip
  indexing ANS-104 bundles.
- Reduced the default number of ANS-104 worker threads from 2 to 1 when
  unbundling is enabled to conserve memory.
- Increased nodejs max old space size to 8GB when ANS-104 workers > 1.

### Fixed

- Adjusted paths for chunks indexed by data root to include the full data root.

## [Release 3] - 2023-12-05

### Added

- Support range requests ([PR 61], [PR 64])
  - Note: serving multiple ranges in a single request is not yet supported.
- Release number in `/ar-io/info` response.
- Redis header cache implementation ([PR 62]).
  - New default header cache (replaces old FS cache).
- LMDB header cache implementation ([PR 60]).
  - Intended for use in development only.
  - Enable by setting `CHAIN_CACHE_TYPE=lmdb`.
- Filesystem header cache cleanup worker ([PR 68]).
  - Enabled by default to cleanup old filesystem cache now that Redis
    is the new default.
- Support for parallel ANS-104 unbundling ([PR 65]).

### Changed

- Used pinned container images tags for releases.
- Default to Redis header cache when running via docker-compose.
- Default to LMDB header cache when running via `yarn start`.

### Fixed

- Correct GraphQL pagination for transactions with duplicate tags.

[PR 68]: https://github.com/ar-io/ar-io-node/pull/68
[PR 65]: https://github.com/ar-io/ar-io-node/pull/65
[PR 64]: https://github.com/ar-io/ar-io-node/pull/64
[PR 62]: https://github.com/ar-io/ar-io-node/pull/62
[PR 61]: https://github.com/ar-io/ar-io-node/pull/61
[PR 60]: https://github.com/ar-io/ar-io-node/pull/60
