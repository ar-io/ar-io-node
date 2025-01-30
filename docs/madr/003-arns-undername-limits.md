# ArNS Undername Limit Enforcement

- Status: proposed
- Deciders: [Ariel], [Dylan], [Atticus], [Phil], [David]
- Date: 2025-01-14
- Authors: [Dylan]

## Context and Problem Statement

ArNS names have a supported undername limit, defined by the ARIO network contract. Increasing this limit requires payment in $ARIO tokens to compensate gateway operators for the additional computational resources needed to serve undername and promote responsible usage of ArNS. AR.IO gateways must enforce this limit when resolving ArNS names to ensure operators are fairly rewarded for their services through fees paid by increasing a names undername limit and providing a consistent experience across the network.

Currently, the `getRecords` API on ANTs return **a table of records** for efficient record lookup. Lua does not guarantee the order of keys in a table, which can cause issues when enforcing undername limits. This creates a need to sort the records by priority order either by modifying or extending the API to return a sorted array of records, or by applying an attribute to the existing records to sort them.

## Decision Outcome

### Priority Resolution Flow

The following sequence diagram is used to demonstrate how AR.IO gateways resolve ArNS names and enforce undername limits.

```mermaid
sequenceDiagram
    participant Client
    participant AR.IO Gateway
    participant ARIOContract
    participant ANTContract

    Client->>AR.IO Gateway: ArNS Name Request
    AR.IO Gateway->>ANTContract: Check ANT records with priority
    ANTContract->>AR.IO Gateway: Return records with priority data
    AR.IO Gateway->>ARIOContract: Get undername limit
    ARIOContract->>AR.IO Gateway: Return undername limit
    note over AR.IO Gateway: Sort records by ANT priority, fallback to alphabetical
    note over AR.IO Gateway: Validate undernames against undername limit
    alt Undername limit exceeded
        AR.IO Gateway->>Client: Return 401
    else Undername limit not exceeded
        AR.IO Gateway->>Client: Resolve undername
    end
```

## Decision Drivers

- Honor ANT priority ordering when available
- Consistent enforcement of undername limits across AR.IO gateways
- Simple fallback mechanism if ANT does not return or contain priority data
- Respects existing ANT records object type (minimal changes to ar-io-node & ar-io-sdk)

## Considered Options

### Option 1: Modify/update API on ANT to return sorted array of records

Lua does not guarantee the order of keys in a table. This raises some issues with the existing `getRecords` API that returns a table of records on an ANT. To circumvent this, we could modify the return type of `getRecords` or introduce a new API to a sorted array of records, based on the ANT priority. This would require a change to the ar-io-sdk and ar-io-node to leverage this updated API.

Current `getRecords` API on ANT:

```lua
function getRecords(name: string)
  return {
    -- order of keys is not guaranteed in lua table
    ["@"] = { transactionId = "0x123", ttlSeconds = 1000000, priority = 0 },
    ["undername1"] = { transactionId = "0x123", ttlSeconds = 1000000, priority = 1 },
    ["undername2"] = { transactionId = "0x123", ttlSeconds = 1000000, priority = 2 }
  }
end
```

Proposed `getSortedRecords` API on ANT:

```lua
function getSortedRecords(name: string):
  local sortedRecords = {}
  -- ANT decides how to sort records
  for key, value in pairs(records) do
    table.insert(sortedRecords, {
      record = key,
      transactionId = value.transactionId,
      ttlSeconds = value.ttlSeconds,
    })
  end
  -- apply sort based on some attribute of the ANT
  table.sort(sortedRecords, function(a, b)
    -- '@' record should always be first
    if a.record == "@" then return true end
    if b.record == "@" then return false end
    return a.record > b.record
  end)
  return sortedRecords
end
```

This array of sorted records would then be what the ar-io-node receives and enforces against the undername limit.

### Option 2: Additional priority attribute in ANT records

ANTs store additional information in their state, indicating the priority of each name. The ar-io-node would respect this priority when resolving undernames. If the ANT does not return priority data, the ar-io-node would sort undernames alphabetically.

Example (in the ar-io-node):

```typescript
const records = getRecords(name);
const sortedRecords = Object.entries(records).sort(([a], [b]) => {
  if ('priority' in a && 'priority' in b) {
    return a.priority - b.priority;
  }
  return a.localeCompare(b);
});

// enforce undername limit against sorted records, using the priority field, fallback to
```

### Option 3: ANT Handler for Priority with existing ANT records

ANTs provide a global `sortOrder` and `sortKey` field to determine how names are sorted on existing records keys.

Example:

```lua
UndernamePriorityAttributes = {
  sortOrder = 'desc',
  sortKey = "name"
}

function getRecords(name: string)
  return {
    -- order of keys is not guaranteed in lua table
    ["@"] = { transactionId = "0x123", ttlSeconds = 1000000, priority = 0 },
    ["undername1"] = { transactionId = "0x123", ttlSeconds = 1000000, priority = 1 },
    ["undername2"] = { transactionId = "0x123", ttlSeconds = 1000000, priority = 2 }
  }
end
```

```typescript
const records = ant.getRecords(name);
const { sortOrder, sortKey } = ant.getPriorityAttributes();
const sortedRecords = Object.entries(records).sort(([a], [b]) => {
  if (sortOrder in a && sortOrder in b) {
    if (sortOrder === 'desc') {
      return a[sortKey] - b[sortKey];
    } else {
      return b[sortKey] - a[sortKey];
    }
  }
  return a.localeCompare(b);
});
```

## Pros and Cons of Options

### Option 1: Modify/update API on ANT to return sorted array of records

#### Pros

✅ Sort order is controlled entirely by ANTs
✅ Fallback to alphabetical sorting when ANT does not contain priority data or ANT not updated

#### Cons

❌ Requires ANT to implement a new API correctly
❌ Requires changes to ANTs, ar-io-nodes and ar-io-sdk's

### Option 2: Additional priority attribute in ANT records

#### Pros

✅ Honors ANT priority ordering when available
✅ Simple fallback mechanism when ANT does not contain priority data or ANT not updated
✅ Minimal changes to ar-io-node & ar-io-sdk

#### Cons

❌ Requires the ar-io-node to fetch full ANT records and sort them by priority order
❌ Gateways have to validate priority attribute, handle collisions (e.g. same priority)

### Option 3: ANT Handler for Priority with existing ANT records

#### Pros

✅ Same pros as above as Option #2

#### Cons

❌ Additional state stored on ANTs
❌ Additional api keys to ANTs when fetching priority attributes

## Decision

We will implement Option 2: **Additional priority attribute in ANT records**

This provides the best balance of honoring ANT priorities while maintaining system availability when the ANT contract is unreachable or outdated. It also respects the existing ANT records object type and limits the amount of changes needed to the ar-io-node and ar-io-sdk.

Example ANT records state with priority data:

```json
{
  "@": {
    "transactionId": "0x123",
    "ttlSeconds": 1000000,
    "priority": 0
  },
  "undername1": {
    "transactionId": "0x123",
    "ttlSeconds": 1000000,
    "priority": 1
  },
  "undername2": {
    "transactionId": "0x123",
    "ttlSeconds": 1000000,
    "priority": 2
  }
}
```

The ar-io-node will sort the records by priority, and fallback to alphabetical sorting when the priority attribute is not present and enforce the undername limit against the sorted records. If ANTs provide invalid priority order (conflicting records with same priority), the ar-io-node will return a 400 error or similar.

## Links

- [ANT Contract Documentation](https://ar.io/ant)
- [ARIO Whitepaper](https://whitepaper.ar.io)

[Ariel]: https://github.com/arielmelendez
[David]: https://github.com/djwhitt
[Dylan]: https://github.com/dtfiedler
[Atticus]: https://github.com/atticusofsparta
[Phil]: https://github.com/vilenarios
