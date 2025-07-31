# AR.IO Node Filtering System

The AR.IO Node filtering system provides a flexible way to match and filter
items based on various criteria. The system is built around JSON-based filter
definitions that can be combined to create both simple and complex matching
patterns.

## Unbundling and Indexing Filters

When processing bundles, the AR.IO Node applies two filters obtained from
environment variables:

```
ANS104_UNBUNDLE_FILTER="<JSON filter string>"
ANS104_INDEX_FILTER="<JSON filter string>"
```

The `ANS104_UNBUNDLE_FILTER` determines which base layer transactions and data
items, in the case of bundles nested in other bundles, are processed, and
the `ANS104_INDEX_FILTER` determines which data items within the processed
bundles are indexed for querying.

## Filter Construction

### Basic Filters

The simplest filters you can use `"always"` and `"never"` filters. The
`"never"` filter is the default behavior and will match nothing, while the
`"always"` filter matches everything.

Never matches any item **(default behavior)**:
```json
{
  "never": true
}
```

Matches every item:
```json
{
  "always": true
}
```

### Tag Filters

Tag filters allow you to match items based on their tags in three different
ways. You can match exact tag values, check for the presence of a tag
regardless of its value, or match tags whose values start with specific text.
All tag values are automatically base64url-decoded before matching.

Exact match:
```json
{
  "tags": [
    {
      "name": "Content-Type",
      "value": "image/jpeg"
    }
  ]
}
```

Match tag name only (any value):
```json
{
  "tags": [
    {
      "name": "App-Name"
    }
  ]
}
```

Starts with match:
```json
{
  "tags": [
    {
      "name": "Protocol",
      "valueStartsWith": "AO"
    }
  ]
}
```

### Attribute Filters

Attribute filtering allows you to match items based on their metadata
properties. The system automatically handles owner public key to address
conversion, making it easy to filter by owner address.

You can combine multiple attributes in a single filter:
```json
{
  "attributes": {
    "owner_address": "xyz123...",
    "data_size": 1000
  }
}
```

### Nested Bundle Filter

The `isNestedBundle` filter is a specialized filter that checks whether a data
item is part of a nested bundle structure. It's particularly useful when you
need to identify or process data items in bundles that are contained within
other bundles.

The filter checks for the presence of a `parent_id` field in the item.
```json
{
  "isNestedBundle": true
}
```

Note: When processing nested bundles, be sure to include filters that match the
nested bundles in both `ANS104_UNBUNDLE_FILTER` and `ANS104_INDEX_FILTER`. The
bundle data items (nested bundles) need to be indexed to be matched by the
unbundle filter.

### Hash Partition Filter

The hash partition filter enables deterministic partitioning of transactions and
data items based on a hash of a specified property. This is particularly useful
for horizontally scaling data processing across multiple nodes, where each node
can handle a specific subset of the data.

Basic partition filter:
```json
{
  "hashPartition": {
    "partitionCount": 10,
    "partitionKey": "owner_address",
    "targetPartitions": [0, 1, 2]
  }
}
```

This filter:
- Divides all items into 10 partitions based on a hash of their owner address
- Matches only items that fall into partitions 0, 1, or 2
- Uses SHA-256 hashing for deterministic distribution

The partition is calculated as: `hash(value) % partitionCount`

Supported partition keys include:
- `id` - Transaction or data item ID
- `owner` - Owner public key
- `owner_address` - Owner address (computed from owner if not present)
- `target` - Target address
- `signature` - Transaction signature
- `quantity` - Transaction quantity
- Any other property present on the transaction/data item

Use cases:

**Uniform Distribution by Transaction ID:**
```json
{
  "hashPartition": {
    "partitionCount": 4,
    "partitionKey": "id",
    "targetPartitions": [0]
  }
}
```
This configuration divides all transactions by their unique ID into 4 partitions.
Since transaction IDs are random, this provides uniform distribution where each
partition receives approximately 25% of all transactions. This is ideal when you
want to evenly distribute processing load without any bias.

Example distribution across 4 nodes:
- Node A: `targetPartitions: [0]` - ~25% of transactions
- Node B: `targetPartitions: [1]` - ~25% of transactions
- Node C: `targetPartitions: [2]` - ~25% of transactions
- Node D: `targetPartitions: [3]` - ~25% of transactions

**Grouped Distribution by Owner:**
```json
{
  "hashPartition": {
    "partitionCount": 100,
    "partitionKey": "owner_address",
    "targetPartitions": [10, 11, 12, 13, 14]
  }
}
```
This configuration creates 100 partitions based on owner address. All
transactions from the same wallet will always go to the same partition. This
node processes only 5% of wallets (partitions 10-14), but will process ALL
transactions from those wallets. This is useful when you need to maintain
wallet-level consistency or analytics.

Note: The hash partition filter only works with transaction-like items (those
with a `tags` property). It will return false for generic objects.

### Complex Filters Using Logical Operators

For more complex scenarios, the system provides logical operators (AND, OR,
NOT) that can be combined to create sophisticated filtering patterns. These
operators can be nested to any depth:

1. AND Operation
```json
{
  "and": [
    {
      "tags": [
        {
          "name": "App-Name",
          "value": "ArDrive-App"
        }
      ]
    },
    {
      "tags": [
        {
          "name": "Content-Type",
          "valueStartsWith": "image/"
        }
      ]
    }
  ]
}
```
2. OR Operation

```json
{
  "or": [
    {
      "tags": [
        {
          "name": "App-Name",
          "value": "ArDrive-App"
        }
      ]
    },
    {
      "attributes": {
        "data_size": 1000
      }
    }
  ]
}
```
3. NOT Operation
```json
{
  "not": {
    "tags": [
      {
        "name": "Content-Type",
        "value": "application/json"
      }
    ]
  }
}
```

## Advanced Examples

### Complex Data Filter

```json
{
  "and": [
    {
      "tags": [
        {
          "name": "App-Name",
          "value": "ArDrive-App"
        },
        {
          "name": "Content-Type",
          "valueStartsWith": "image/"
        }
      ]
    },
    {
      "attributes": {
        "data_size": 1000000
      }
    },
    {
      "not": {
        "isNestedBundle": true
      }
    }
  ]
}
```

The filter uses an `"and"` operator at the top level, which means ALL of these
conditions must be true:
- Must have a tag with name `"App-Name"` that exactly matches `"ArDrive-App"`
- Must have a tag with name `"Content-Type"` that starts with `"image/"`
  (matches image/png, image/jpeg, etc.)
- The item must have a `data_size` attribute equal to `1000000` bytes
- The item must NOT be part of a nested bundle (must not have a `parent_id`)

### Multi-condition Tag Filter

```json
{
  "or": [
    {
      "and": [
        {
          "tags": [
            {
              "name": "Content-Type",
            }
          ]
        },
        {
          "tags": [
            {
              "name": "Version",
              "value": "1.0"
            }
          ]
        }
      ]
    },
    {
      "tags": [
        {
          "name": "Type",
          "value": "Legacy"
        }
      ]
    }
  ]
}
```

This filter uses a combination of OR and AND operators to match items that
satisfy either of two conditions.

This filter will match items that either:
- Have any content type AND version 1.0 tags
- OR have a tag named `"Type"` with value `"Legacy"`

### Exclusion Filter with App-Name Pattern Matching

```json
{
  "and": [
    {
      "not": {
        "or": [
          {
            "tags": [
              {
                "name": "Bundler-App-Name",
                "value": "Warp"
              }
            ]
          },
          {
            "tags": [
              {
                "name": "Bundler-App-Name",
                "value": "Redstone"
              }
            ]
          },
          {
            "tags": [
              {
                "name": "Bundler-App-Name",
                "value": "Kyve"
              }
            ]
          },
          {
            "tags": [
              {
                "name": "Bundler-App-Name",
                "value": "AO"
              }
            ]
          },
        ]
      }
    },
    {
      "tags": [
        {
          "name": "App-Name",
          "valueStartsWith": "ArDrive"
        }
      ]
    }
  ]
}
```

This filter combines exclusion logic with pattern matching to filter specific
items. It uses an AND operator at the top level requiring BOTH conditions to be
true.

This filter will match items that:
- Are NOT bundled by Warp, Redstone, Kyve, or AO bundlers
- AND have an `App-Name` tag that starts with `"ArDrive"`

This type of filter is useful when you want to process ArDrive-related items
while explicitly excluding items from specific bundlers.

### Distributed Processing with Hash Partitioning

```json
{
  "and": [
    {
      "hashPartition": {
        "partitionCount": 4,
        "partitionKey": "owner_address",
        "targetPartitions": [0]
      }
    },
    {
      "tags": [
        {
          "name": "App-Name",
          "value": "ArDrive-App"
        }
      ]
    }
  ]
}
```

This filter combines hash partitioning with tag filtering for distributed
processing. It uses an AND operator to require both conditions.

This filter will match items that:
- Fall into partition 0 of a 4-partition scheme based on owner address (25% of items)
- AND have an `App-Name` tag with value `"ArDrive-App"`

This approach allows multiple nodes to process different partitions in parallel:
- Node 1: `targetPartitions: [0]`
- Node 2: `targetPartitions: [1]`
- Node 3: `targetPartitions: [2]`
- Node 4: `targetPartitions: [3]`

Each node processes only its assigned partition, enabling horizontal scaling
while ensuring no data is processed by multiple nodes.

---

All these filters can be used in various contexts within the AR.IO Node, such
as configuring webhook triggers, controlling ANS-104 bundle processing, or
setting up data indexing rules. The filtering system is designed to be
intuitive yet powerful, allowing for precise control over which items get
processed while maintaining readable and maintainable filter definitions.

Important Notes:
- All tag names and values are base64url-decoded before matching
- Owner addresses are automatically converted from owner public keys
- Empty or undefined filters default to "never match"
- Tag matching requires all specified tags to match
- Attribute matching requires all specified attributes to match
- The filter system supports nested logical operations to any depth, allowing
  for very precise control over what data gets processed.
