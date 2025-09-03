#!/usr/bin/env python3
"""
AR.IO Gateway - Generate Iceberg Metadata for Parquet Files
Creates Apache Iceberg metadata for partitioned Parquet data
"""

import json
import os
import sys
import glob
import uuid
import argparse
from datetime import datetime, timezone
from pathlib import Path


def generate_table_metadata(table_name, schema, partition_spec, data_files, warehouse_dir):
    """Generate Iceberg table metadata JSON"""
    
    current_snapshot_id = int(datetime.now().timestamp() * 1000)
    
    metadata = {
        "format-version": 2,
        "table-uuid": str(uuid.uuid4()),
        "location": f"file://{os.path.abspath(warehouse_dir)}/{table_name}",
        "last-sequence-number": 1,
        "last-updated-ms": int(datetime.now().timestamp() * 1000),
        "last-column-id": len(schema["fields"]),
        "current-schema-id": 0,
        "schemas": [schema],
        "default-spec-id": 0,
        "partition-specs": [partition_spec],
        "last-partition-id": 1000,
        "default-sort-order-id": 0,
        "sort-orders": [{"order-id": 0, "fields": []}],
        "properties": {
            "created-by": "ar-io-node-parquet-export",
            "engine.hive.enabled": "true",
            "write.format.default": "parquet",
            "write.parquet.compression-codec": "zstd"
        },
        "current-snapshot-id": current_snapshot_id,
        "refs": {
            "main": {
                "snapshot-id": current_snapshot_id,
                "type": "branch"
            }
        },
        "snapshots": [{
            "sequence-number": 1,
            "snapshot-id": current_snapshot_id,
            "timestamp-ms": int(datetime.now().timestamp() * 1000),
            "summary": {
                "operation": "append",
                "added-data-files": str(len(data_files)),
                "added-records": "0",  # Would need to scan files for actual count
                "added-files-size": str(sum(os.path.getsize(f) for f in data_files if os.path.exists(f))),
                "changed-partition-count": str(len(set(os.path.dirname(f) for f in data_files)))
            },
            "manifest-list": f"snap-{current_snapshot_id}-1-manifest-list.json"
        }],
        "statistics": [],
        "partition-statistics": []
    }
    
    return metadata


def generate_manifest_list(table_name, snapshot_id, manifests):
    """Generate Iceberg manifest list in JSON format
    
    Note: Production Iceberg uses Avro format for manifests.
    This creates a JSON representation for compatibility with tools that can read JSON."""
    manifest_list = {
        "manifest-length": len(manifests),
        "manifests": manifests
    }
    
    return manifest_list


def generate_manifest(table_name, data_files, partition_spec, partition_size, warehouse_dir):
    """Generate Iceberg manifest file in JSON format
    
    Note: Production Iceberg uses Avro format for manifests.
    This creates a JSON representation for compatibility with tools that can read JSON."""
    entries = []
    
    for data_file in data_files:
        # Extract partition info from path
        partition_match = os.path.basename(os.path.dirname(data_file))
        if partition_match.startswith("height="):
            height_range = partition_match.replace("height=", "")
            start_height, end_height = height_range.split("-")
            
            # Make path relative to warehouse directory
            relative_path = os.path.relpath(data_file, warehouse_dir)
            
            entries.append({
                "status": 1,  # ADDED
                "snapshot_id": None,
                "sequence_number": None,
                "data_file": {
                    "content": "DATA",
                    "file_path": relative_path,
                    "file_format": "PARQUET",
                    "partition": {"height_bucket": int(start_height) // partition_size},
                    "record_count": 0,  # Would need to scan file
                    "file_size_in_bytes": os.path.getsize(data_file) if os.path.exists(data_file) else 0,
                    "column_sizes": None,
                    "value_counts": None,
                    "null_value_counts": None,
                    "nan_value_counts": None,
                    "lower_bounds": None,
                    "upper_bounds": None,
                    "key_metadata": None,
                    "split_offsets": None,
                    "equality_ids": None,
                    "sort_order_id": 0
                }
            })
    
    return {"entries": entries}


# Define schemas for each table
SCHEMAS = {
    "blocks": {
        "type": "struct",
        "schema-id": 0,
        "fields": [
            {"id": 1, "name": "indep_hash", "required": True, "type": "string"},
            {"id": 2, "name": "height", "required": True, "type": "long"},
            {"id": 3, "name": "previous_block", "required": False, "type": "string"},
            {"id": 4, "name": "nonce", "required": False, "type": "string"},
            {"id": 5, "name": "hash", "required": False, "type": "string"},
            {"id": 6, "name": "block_timestamp", "required": False, "type": "long"},
            {"id": 7, "name": "tx_count", "required": False, "type": "int"},
            {"id": 8, "name": "block_size", "required": False, "type": "long"}
        ]
    },
    "transactions": {
        "type": "struct",
        "schema-id": 0,
        "fields": [
            {"id": 1, "name": "id", "required": True, "type": "string"},
            {"id": 2, "name": "indexed_at", "required": False, "type": "long"},
            {"id": 3, "name": "block_transaction_index", "required": False, "type": "int"},
            {"id": 4, "name": "is_data_item", "required": True, "type": "int"},
            {"id": 5, "name": "target", "required": False, "type": "string"},
            {"id": 6, "name": "quantity", "required": False, "type": "string"},
            {"id": 7, "name": "reward", "required": False, "type": "string"},
            {"id": 8, "name": "anchor", "required": False, "type": "string"},
            {"id": 9, "name": "data_size", "required": False, "type": "long"},
            {"id": 10, "name": "content_type", "required": False, "type": "string"},
            {"id": 11, "name": "format", "required": False, "type": "int"},
            {"id": 12, "name": "height", "required": True, "type": "long"},
            {"id": 13, "name": "owner_address", "required": False, "type": "string"},
            {"id": 14, "name": "data_root", "required": False, "type": "string"},
            {"id": 15, "name": "parent", "required": False, "type": "string"},
            {"id": 16, "name": "offset", "required": False, "type": "long"},
            {"id": 17, "name": "size", "required": False, "type": "long"},
            {"id": 18, "name": "data_offset", "required": False, "type": "long"},
            {"id": 19, "name": "owner_offset", "required": False, "type": "long"},
            {"id": 20, "name": "owner_size", "required": False, "type": "long"},
            {"id": 21, "name": "owner", "required": False, "type": "binary"},
            {"id": 22, "name": "signature_offset", "required": False, "type": "long"},
            {"id": 23, "name": "signature_size", "required": False, "type": "long"},
            {"id": 24, "name": "signature_type", "required": False, "type": "int"},
            {"id": 25, "name": "root_transaction_id", "required": False, "type": "string"},
            {"id": 26, "name": "root_parent_offset", "required": False, "type": "long"}
        ]
    },
    "tags": {
        "type": "struct",
        "schema-id": 0,
        "fields": [
            {"id": 1, "name": "height", "required": True, "type": "long"},
            {"id": 2, "name": "id", "required": True, "type": "string"},
            {"id": 3, "name": "tag_index", "required": True, "type": "int"},
            {"id": 4, "name": "indexed_at", "required": False, "type": "long"},
            {"id": 5, "name": "tag_name", "required": False, "type": "string"},
            {"id": 6, "name": "tag_value", "required": False, "type": "string"},
            {"id": 7, "name": "is_data_item", "required": True, "type": "int"}
        ]
    }
}


def main():
    parser = argparse.ArgumentParser(
        description='Generate Apache Iceberg metadata for AR.IO Parquet exports',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --warehouse-dir data/local/warehouse
  %(prog)s --warehouse-dir /path/to/warehouse --partition-size 5000
  
Query the generated tables:
  DuckDB:
    INSTALL iceberg;
    LOAD iceberg;
    SELECT * FROM iceberg_scan('data/local/warehouse/blocks/metadata/metadata.json');
    
  Apache Spark:
    spark.sql.catalog.ar_io.warehouse = data/local/warehouse
    spark.table("ar_io.default.blocks").show()
"""
    )
    
    parser.add_argument(
        '--warehouse-dir',
        default='data/local/warehouse',
        help='Warehouse directory containing Parquet data (default: data/local/warehouse)'
    )
    
    parser.add_argument(
        '--catalog-name',
        default='ar-io-catalog',
        help='Name for the Iceberg catalog (default: ar-io-catalog)'
    )
    
    parser.add_argument(
        '--namespace',
        default='default',
        help='Namespace for tables (default: default)'
    )
    
    parser.add_argument(
        '--partition-size',
        type=int,
        default=1000,
        help='Expected partition size for validation (default: 1000)'
    )
    
    args = parser.parse_args()
    
    # Check if warehouse directory exists
    if not os.path.exists(args.warehouse_dir):
        print(f"Error: Warehouse directory does not exist: {args.warehouse_dir}", file=sys.stderr)
        sys.exit(1)
    
    print(f"Generating Iceberg metadata for warehouse: {args.warehouse_dir}")
    print(f"Catalog: {args.catalog_name}")
    print(f"Namespace: {args.namespace}")
    print()
    
    # Define partition spec (bucket by height)
    partition_spec = {
        "spec-id": 0,
        "fields": [{
            "source-id": 2,  # height field
            "field-id": 1000,
            "name": "height_bucket",
            "transform": f"bucket[{args.partition_size}]"
        }]
    }
    
    # Process each table
    for table_name in ["blocks", "transactions", "tags"]:
        table_dir = os.path.join(args.warehouse_dir, table_name)
        if not os.path.exists(table_dir):
            print(f"Skipping {table_name}: directory does not exist")
            continue
        
        print(f"Processing table: {table_name}")
        
        # Find all Parquet files
        data_dir = os.path.join(table_dir, "data")
        if not os.path.exists(data_dir):
            print(f"  No data directory found for {table_name}")
            continue
        
        parquet_files = glob.glob(os.path.join(data_dir, "*/*.parquet"))
        if not parquet_files:
            print(f"  No Parquet files found for {table_name}")
            continue
        
        print(f"  Found {len(parquet_files)} Parquet files")
        
        # Create metadata directory
        metadata_dir = os.path.join(table_dir, "metadata")
        os.makedirs(metadata_dir, exist_ok=True)
        
        # Generate table metadata
        table_metadata = generate_table_metadata(
            table_name,
            SCHEMAS[table_name],
            partition_spec,
            parquet_files,
            args.warehouse_dir
        )
        
        # Write metadata.json
        metadata_file = os.path.join(metadata_dir, "v1.metadata.json")
        with open(metadata_file, "w") as f:
            json.dump(table_metadata, f, indent=2)
        
        # Create symlink for current metadata
        current_metadata = os.path.join(metadata_dir, "metadata.json")
        if os.path.exists(current_metadata):
            os.remove(current_metadata)
        os.symlink(os.path.basename(metadata_file), current_metadata)
        
        # Create version-hint.text file for DuckDB
        version_hint_file = os.path.join(metadata_dir, "version-hint.text")
        with open(version_hint_file, "w") as f:
            f.write("1")
        
        print(f"  Created metadata: {metadata_file}")
        
        # Generate manifest in JSON format
        snapshot_id = table_metadata["current-snapshot-id"]
        manifest_data = generate_manifest(table_name, parquet_files, partition_spec, args.partition_size, args.warehouse_dir)
        manifest_file = os.path.join(metadata_dir, f"manifest-{uuid.uuid4()}.json")
        with open(manifest_file, "w") as f:
            json.dump(manifest_data, f, indent=2)
        
        # Generate manifest list  
        # Use relative path from the metadata directory
        manifest_list_data = generate_manifest_list(table_name, snapshot_id, [
            {
                "manifest_path": os.path.basename(manifest_file),
                "added_snapshot_id": snapshot_id,
                "partition_spec_id": 0,
                "content": "data",
                "sequence_number": 1,
                "min_sequence_number": 1,
                "added_files_count": len(parquet_files),
                "existing_files_count": 0,
                "deleted_files_count": 0,
                "added_rows_count": 0,
                "existing_rows_count": 0,
                "deleted_rows_count": 0
            }
        ])
        
        manifest_list_file = os.path.join(metadata_dir, f"snap-{snapshot_id}-1-manifest-list.json")
        with open(manifest_list_file, "w") as f:
            json.dump(manifest_list_data, f, indent=2)
        
        print(f"  Created manifest: {manifest_file}")
        print(f"  Created manifest list: {manifest_list_file}")
    
    print()
    print("Iceberg metadata generation complete!")
    print(f"Tables are now queryable at: {os.path.abspath(args.warehouse_dir)}")
    print()
    print("Note: This generates JSON-formatted Iceberg metadata.")
    print("Standard Iceberg uses Avro format for manifest files.")
    print("For full Iceberg compatibility with all tools, consider using")
    print("PyIceberg or Java Iceberg libraries to generate Avro manifests.")
    print()
    print("To query these tables with DuckDB:")
    print("  duckdb")
    print("  INSTALL iceberg;")
    print("  LOAD iceberg;")
    print(f"  SELECT * FROM iceberg_scan('{args.warehouse_dir}/blocks/metadata/metadata.json');")
    print()
    print("To query with Apache Spark:")
    print(f"  spark.sql.catalog.{args.catalog_name}=org.apache.iceberg.spark.SparkCatalog")
    print(f"  spark.sql.catalog.{args.catalog_name}.type=hadoop")
    print(f"  spark.sql.catalog.{args.catalog_name}.warehouse={args.warehouse_dir}")


if __name__ == '__main__':
    main()