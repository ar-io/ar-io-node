#!/usr/bin/env node
/**
 * Script to add dataItemId fields to a CDB64 manifest by reading ANS-104 bundle headers.
 *
 * Usage: node scripts/add-data-item-ids-to-manifest.mjs <manifest-path>
 */

import * as fs from 'node:fs';

const GATEWAY_URL = 'https://arweave.net';

// Read a 256-bit little-endian integer from a buffer (only first 8 bytes needed)
function readUint256LE(buffer, offset) {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(buffer[offset + i]) << BigInt(i * 8);
  }
  return value;
}

// Convert buffer to base64url
function toB64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function fetchBundleHeader(rootTxId) {
  // First, fetch the count (first 32 bytes)
  const countResponse = await fetch(`${GATEWAY_URL}/${rootTxId}`, {
    headers: { 'Range': 'bytes=0-31' }
  });

  if (!countResponse.ok) {
    throw new Error(`Failed to fetch count for ${rootTxId}: ${countResponse.status}`);
  }

  const countBuffer = Buffer.from(await countResponse.arrayBuffer());
  const itemCount = Number(readUint256LE(countBuffer, 0));

  console.log(`  ${rootTxId}: ${itemCount} data items`);

  // ANS-104 bundle header structure (see src/lib/bundles.ts):
  // - 32 bytes: item count
  // - For each item: 64 bytes INTERLEAVED (32 bytes size + 32 bytes id)
  const headersLength = 64 * itemCount;
  const headerSize = 32 + headersLength;

  const headerResponse = await fetch(`${GATEWAY_URL}/${rootTxId}`, {
    headers: { 'Range': `bytes=0-${headerSize - 1}` }
  });

  if (!headerResponse.ok) {
    throw new Error(`Failed to fetch header for ${rootTxId}: ${headerResponse.status}`);
  }

  const headerBuffer = Buffer.from(await headerResponse.arrayBuffer());

  // Parse interleaved sizes and IDs (64 bytes per item: 32 size + 32 id)
  const items = [];
  let cumulativeOffset = headerSize; // Data items start after header

  for (let i = 0; i < headersLength; i += 64) {
    const pairOffset = 32 + i;
    const size = Number(readUint256LE(headerBuffer, pairOffset));
    const idBytes = headerBuffer.subarray(pairOffset + 32, pairOffset + 64);
    const id = toB64Url(idBytes);

    // This data item spans from cumulativeOffset to cumulativeOffset + size
    items.push({
      startOffset: cumulativeOffset,
      endOffset: cumulativeOffset + size,
      size,
      id
    });

    cumulativeOffset += size;
  }

  return items;
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error('Usage: node scripts/add-data-item-ids-to-manifest.mjs <manifest-path>');
    process.exit(1);
  }

  console.log(`Reading manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  // Get unique root TX IDs
  const rootTxIds = [...new Set(manifest.partitions.map(p => p.location.rootTxId))];
  console.log(`\nFetching headers for ${rootTxIds.length} root transactions...`);

  // Fetch all bundle headers
  const bundleHeaders = new Map();
  for (const rootTxId of rootTxIds) {
    try {
      const items = await fetchBundleHeader(rootTxId);
      bundleHeaders.set(rootTxId, items);
    } catch (error) {
      console.error(`  Error fetching ${rootTxId}: ${error.message}`);
    }
  }

  // Update manifest with data item IDs
  console.log('\nUpdating manifest partitions...');
  let updatedCount = 0;
  let notFoundCount = 0;

  for (const partition of manifest.partitions) {
    const { rootTxId, dataOffsetInRootTx } = partition.location;
    const items = bundleHeaders.get(rootTxId);

    if (!items) {
      console.log(`  Warning: No header data for ${rootTxId}`);
      notFoundCount++;
      continue;
    }

    // Find the data item that contains this offset
    // dataOffsetInRootTx points to the payload data, which is within the data item's range
    const foundItem = items.find(item =>
      dataOffsetInRootTx >= item.startOffset && dataOffsetInRootTx < item.endOffset
    );

    if (foundItem) {
      partition.location.dataItemId = foundItem.id;
      updatedCount++;
    } else {
      console.log(`  Warning: Could not find data item for partition ${partition.prefix} (offset ${dataOffsetInRootTx} in ${rootTxId})`);
      notFoundCount++;
    }
  }

  console.log(`\nUpdated ${updatedCount} partitions, ${notFoundCount} not found`);

  // Write updated manifest
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nSaved updated manifest to ${manifestPath}`);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
