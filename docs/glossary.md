# AR.IO Node Glossary

This glossary defines key terms and concepts used throughout the AR.IO Node
codebase. Terms are organized by category and alphabetically within each
section.

## Core Arweave Concepts

<a id="block"></a> **Block** - The fundamental unit of the Arweave blockchain
containing a set of transactions. Each block has a unique height (sequential
number) and hash identifier.

<a id="chunk"></a> **Chunk** - A 256KiB segment of transaction data. Large
transactions are split into chunks for efficient storage and retrieval using
Merkle trees for verification. Transaction costs are proportional to the number
of chunks required.

<a id="data-root"></a> **Data Root** - The Merkle tree root hash of a
transaction's data chunks. Used to cryptographically verify data integrity
without downloading the entire transaction.

<a id="item-id"></a> **Item ID** - A unifying term for both transaction IDs and
data item IDs. Both are unique identifiers derived from cryptographic signatures
that identify stored data on Arweave. Note that "transaction ID" is often used
interchangeably for "item ID" in the Arweave ecosystem, and item IDs are also
sometimes referred to as "data IDs" in ar.io projects. This codebase attempts to
always distinguish between "item ID", "transaction ID", and "data item ID" where
appropriate for maximum clarity.

**Stable/New Data** - Classification based on block confirmations. Stable data
is from blocks unlikely to be reorganized (18+ blocks deep), while new data is
from recent blocks that could still be affected by chain reorganizations.

<a id="tags"></a> **Tags** - Key-value metadata pairs attached to transactions
and data items. Tags are indexed and searchable, enabling content discovery and
application-specific functionality. Includes both transaction tags and data item
tags.

<a id="transaction"></a> **Transaction** - A data storage unit on Arweave
identified by a unique 43-character base64url [item ID](#item-id). Contains
data, tags, and cryptographic signatures proving ownership and integrity. Note
that "transaction ID" is often used interchangeably with "item ID" in the
broader Arweave ecosystem. This codebase attempts to always distinguish between
"item ID", "transaction ID", and "data item ID" where appropriate for maximum
clarity.

<a id="weave"></a> **Weave** - The concatenated sequence of all transaction data
on Arweave, forming the complete blockchain dataset.

## ANS-104 Bundle System

**ANS-102/ANS-104** - Arweave standards for bundling multiple data items into a
single transaction. ANS-104 is the current standard supporting advanced features
like nested bundles.

<a id="bdi"></a> **BDI (Bundle Data Item)** - A [data item](#data-item) that
itself is a [bundle](#bundle), enabling nested bundle structures within the
ANS-104 standard.

<a id="bundle"></a> **Bundle** - A collection of [data items](#data-item) packed
into a single Arweave [transaction](#transaction). Bundles reduce costs and
improve throughput by amortizing transaction overhead and making efficient use
of chunk space.

**Bundle Format** - The specific standard (ANS-102 or ANS-104) used to encode a
bundle. The format determines how data items are structured and indexed within
the bundle.

<a id="data-item"></a> **Data Item** - An individual piece of data within a
bundle. Each data item has its own ID, signature, tags, and data, similar to a
transaction but more lightweight.

<a id="data-item-id"></a> **Data Item ID** - A unique [item ID](#item-id) for a
[data item](#data-item) within a bundle, calculated from the data item's
signature.

<a id="nested-bundle"></a> **Nested Bundle** - A [bundle](#bundle) contained
within another bundle. Identified by having a parent_id field pointing to the
containing bundle.

<a id="parent-id"></a> **Parent ID** - The identifier of the containing
[bundle](#bundle) or [transaction](#transaction) for a data item. For data items
in nested bundles, points to the immediate parent bundle. For top-level data
items, equals the [root transaction ID](#root-transaction-id).

<a id="root-transaction-id"></a> **Root Transaction ID** - The top-level Arweave
[transaction](#transaction) ID containing a [bundle](#bundle) or data item. Used
to retrieve the raw data from Arweave.

<a id="unbundling"></a> **Unbundling** - The process of extracting and indexing
individual [data items](#data-item) from a [bundle](#bundle) transaction.

## AR.IO Gateway Concepts

**ArNS (Arweave Name System)** - A decentralized naming system that maps
human-readable names to Arweave [item IDs](#item-id), similar to DNS for the
permaweb.

<a id="contiguous-data"></a> **Contiguous Data** - Complete data, potentially
reassembled from multiple [chunks](#chunk), of a [transaction](#transaction) or
[data item](#data-item). The gateway stores metadata about contiguous data
availability and verification status.

<a id="undername"></a> **Undername** - A subdomain-like path component in ArNS
resolution (e.g., 'app' in 'app_myname' resolves to a path within the manifest).

**Observer** - A gateway component that monitors and reports on the health and
behavior of other gateways in the AR.IO network.

**X-AR-IO Headers** - HTTP headers added by the gateway providing metadata about
data verification, caching, and trust status.

**X-ArNS Headers** - HTTP response headers added during ArNS name resolution
that provide metadata about the resolution process, including the resolved
[item ID](#item-id), TTL (Time To Live), process ID, and [undername](#undername)
information.

## Databases

**Bundles Database** - SQLite database storing ANS-104 bundle metadata,
[data items](#data-item), and their relationships. Includes retry tracking for
bundle processing.

**Core Database** - Primary SQLite database containing blocks,
[transactions](#transaction), transaction [tags](#tags), stable/new data
indexes, and the migrations table that tracks applied database schema changes.

**Data Database** - SQLite database tracking contiguous data availability,
verification status, and retry attempts.

**Moderation Database** - SQLite database managing content blocking and
filtering rules.

## Data Storage Architecture

**Cache Store** - High-speed storage layer (Redis or filesystem) for frequently
accessed data chunks and headers.

**Chunk Data Store** - Backend storage for transaction chunks. Supports multiple
implementations including filesystem and S3.

**Contiguous Data Store** - Storage backend for complete transaction data.
Manages both data files and verification metadata.

## Data Verification

**Data Verification** - The process of cryptographically verifying data
integrity. For transactions, this involves verifying that retrieved data matches
its [data root](#data-root) hash and comparing it to the chain, confirming the
transaction is part of Arweave. Once a transaction is verified, if it contains a
[bundle](#bundle), this verification also confirms that all
[data items](#data-item) within it are part of Arweave. For data items
specifically, verification includes checking they are correctly positioned
within their parent bundles, their signatures are valid, and their IDs (hashed
signatures) are correct.

**Verification Priority** - Numeric value determining the order of data
verification. Higher priority items are verified first.

**Verification Retry Count** - Number of failed verification attempts for a
piece of data. Used with exponential backoff to manage retries.

## Resolution

**Root Transaction Index** - Service that resolves data items to their root
bundle transactions, enabling retrieval of the original Arweave transaction
containing bundled data.

**Name Resolution** - The process of converting names or identifiers to
[item IDs](#item-id). The primary type is ArNS resolution, which maps
human-readable names (like "my-app") to their corresponding Arweave
[item IDs](#item-id).

**Path Resolution** - The process of interpreting URL paths to determine which
transaction data to serve. Includes manifest resolution (looking up paths in a
manifest's routing table), index path resolution (adding index.html), and
fallback path handling for 404 errors.

**Manifest** - A special JSON document that maps paths to [item IDs](#item-id),
enabling directory-like navigation of Arweave data.

**Sandbox** - A security mechanism that redirects data access to unique
subdomains based on the [item ID](#item-id). Each item gets its own
base32-encoded subdomain, providing browser origin isolation between different
applications and content.

## Worker Architecture

**ANS-104 Unbundler** - Worker process that extracts data items from bundle
transactions and queues them for indexing.

**Block Importer** - Worker that fetches new blocks from Arweave peers and
imports them into the core database.

**Bundle Repair Worker** - Process that identifies and reprocesses failed bundle
imports.

**Cleanup Workers** - Background processes that remove old data from caches and
databases based on retention policies.

**Data Item Indexer** - Worker that processes extracted data items, storing
their metadata and tags in the database.

**Data Verification Worker** - Background process that verifies data integrity
by comparing stored data against its cryptographic root hash.

**Transaction Fetcher** - Worker that retrieves transaction headers and data
from Arweave peers.

**Transaction Importer** - Process that imports fetched transaction data into
the appropriate databases.

## Filtering System

**Filter** - A JSON-based configuration that determines which items match
specific criteria. Filters can match based on tags, attributes, or complex
logical conditions.

**Index Filter** - Filter determining which data items within bundles get
indexed in the database.

**Log Filter** - Filter applied to Winston logs to show only logs matching
specific criteria, reducing log noise.

**Unbundle Filter** - Filter determining which transactions and nested bundles
are processed for data item extraction.

**Webhook Filter** - Filter determining which indexed transactions or data items
trigger webhook notifications.

## Offsets

Offsets are numeric positions that indicate where data is located within the
Arweave [weave](#weave), [transactions](#transaction), or [bundles](#bundle).
AR.IO Node uses multiple offset types to efficiently locate and retrieve data.

**Absolute Offset** - The global byte position within the entire Arweave
[weave](#weave). Used to retrieve chunks from Arweave nodes using the
`/chunk/{offset}` endpoint.

**Transaction Offset** - The end position (last byte) of a
[transaction](#transaction) in the [weave](#weave). Combined with transaction
size to calculate start position.

**Relative Offset** - Position relative to the start of a transaction. Used
primarily for chunk positions in Merkle proofs and data paths. While other
offsets may be relative to bundles or data items, the term "relative offset"
typically refers specifically to transaction-relative positions.

**Data Offset** - For [data items](#data-item), the starting position of actual
data content (payload) within a data item, relative to the parent bundle's
start. Calculated by adding the data item's offset to the size of its headers
and metadata.

**Root Parent Offset** - The offset of the parent [bundle's](#bundle) data
payload relative to the root [transaction](#transaction). For top-level bundles,
this is 0. For nested bundles, calculated by adding the parent's
root_parent_offset to its data_offset. Used to locate [data items](#data-item)
within the root transaction without traversing the bundle hierarchy.

**Signature Offset** - For [data items](#data-item), position where the
signature bytes begin, relative to the parent bundle's start. Located 2 bytes
after the data item's start position (after the signature type field).

**Owner Offset** - For [data items](#data-item), position where the owner public
key begins, relative to the parent bundle's start. Located immediately after the
signature bytes.

**Data Item Offset** - The position of a [data item](#data-item) within its
parent [bundle](#bundle), relative to the bundle's start. Used to locate
specific items within bundled data.

## Network Participation

**Admin API Key** - Authentication token required to access administrative
endpoints like content moderation and queue management.

**AR.IO Network** - Decentralized network of gateways providing cached and
indexed access to Arweave data.

**Gateway** - A node in the AR.IO network that indexes, caches, and serves
Arweave data with enhanced query capabilities.

**Gateway Wallet** - The wallet address associated with a gateway for
identification and participation in the AR.IO network.

**Observer Reports** - Health and performance data submitted by gateways about
other gateways in the network.

**Observer Wallet** - A wallet used to sign and submit observation reports about
other gateways in the network, enabling decentralized monitoring.

## Additional Terms

**Base64URL** - URL-safe base64 encoding used throughout Arweave for IDs, data
encoding, and signatures.

**Circuit Breaker** - A fault tolerance pattern that prevents cascading failures
by temporarily blocking requests to failing services. Opens after threshold
failures, enters half-open state after timeout, and closes after successful
requests.

**Content Type/Encoding** - MIME type and compression format of stored data,
preserved from the original upload.

**Signature Type** - The cryptographic algorithm used to sign a transaction or
data item (e.g., RSA, ED25519, Ethereum, Solana).

**TTL (Time To Live)** - The duration for which an ArNS name resolution is
cached before requiring refresh.

**Webhook** - HTTP callback triggered when indexed data matches a configured
filter, enabling real-time integrations.
