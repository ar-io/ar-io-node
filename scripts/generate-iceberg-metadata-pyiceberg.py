#!/usr/bin/env python3
"""
AR.IO Gateway - Generate Iceberg Metadata using PyIceberg
Creates proper Apache Iceberg metadata for partitioned Parquet data
"""

import os
import sys
import glob
import argparse
from pathlib import Path

try:
    from pyiceberg.catalog import load_catalog
    from pyiceberg.catalog.sql import SqlCatalog
    from pyiceberg.schema import Schema
    from pyiceberg.types import (
        NestedField, StringType, LongType, IntegerType, 
        BooleanType, BinaryType, StructType
    )
    from pyiceberg.partitioning import PartitionSpec, PartitionField
    from pyiceberg.transforms import BucketTransform
    from pyiceberg.table import Table
    import pyarrow.parquet as pq
    import pyarrow as pa
except ImportError as e:
    print(f"Error: Required library not installed: {e}")
    print("\nPlease install PyIceberg and dependencies:")
    print("  pip install pyiceberg[pyarrow,duckdb,sql]")
    sys.exit(1)


# Define schemas for each table
def get_blocks_schema():
    """Get the schema for blocks table"""
    return Schema(
        NestedField(1, "indep_hash", StringType(), required=True),
        NestedField(2, "height", LongType(), required=True),
        NestedField(3, "previous_block", StringType(), required=False),
        NestedField(4, "nonce", StringType(), required=False),
        NestedField(5, "hash", StringType(), required=False),
        NestedField(6, "block_timestamp", LongType(), required=False),
        NestedField(7, "tx_count", IntegerType(), required=False),
        NestedField(8, "block_size", LongType(), required=False),
    )


def get_transactions_schema():
    """Get the schema for transactions table"""
    return Schema(
        NestedField(1, "id", StringType(), required=True),
        NestedField(2, "indexed_at", LongType(), required=False),
        NestedField(3, "block_transaction_index", IntegerType(), required=False),
        NestedField(4, "is_data_item", IntegerType(), required=True),
        NestedField(5, "target", StringType(), required=False),
        NestedField(6, "quantity", StringType(), required=False),
        NestedField(7, "reward", StringType(), required=False),
        NestedField(8, "anchor", StringType(), required=False),
        NestedField(9, "data_size", LongType(), required=False),
        NestedField(10, "content_type", StringType(), required=False),
        NestedField(11, "format", IntegerType(), required=False),
        NestedField(12, "height", LongType(), required=True),
        NestedField(13, "owner_address", StringType(), required=False),
        NestedField(14, "data_root", StringType(), required=False),
        NestedField(15, "parent", StringType(), required=False),
        NestedField(16, "offset", LongType(), required=False),
        NestedField(17, "size", LongType(), required=False),
        NestedField(18, "data_offset", LongType(), required=False),
        NestedField(19, "owner_offset", LongType(), required=False),
        NestedField(20, "owner_size", LongType(), required=False),
        NestedField(21, "owner", BinaryType(), required=False),
        NestedField(22, "signature_offset", LongType(), required=False),
        NestedField(23, "signature_size", LongType(), required=False),
        NestedField(24, "signature_type", IntegerType(), required=False),
        NestedField(25, "root_transaction_id", StringType(), required=False),
        NestedField(26, "root_parent_offset", LongType(), required=False),
    )


def get_tags_schema():
    """Get the schema for tags table"""
    return Schema(
        NestedField(1, "height", LongType(), required=True),
        NestedField(2, "id", StringType(), required=True),
        NestedField(3, "tag_index", IntegerType(), required=True),
        NestedField(4, "indexed_at", LongType(), required=False),
        NestedField(5, "tag_name", StringType(), required=False),
        NestedField(6, "tag_value", StringType(), required=False),
        NestedField(7, "is_data_item", IntegerType(), required=True),
    )


def create_local_catalog(warehouse_dir):
    """Create a local file-based Iceberg catalog using SQL catalog"""
    catalog_path = os.path.join(warehouse_dir, "catalog.db")
    
    # Use SQL catalog for local file system
    catalog = SqlCatalog(
        "ar_io_catalog",
        **{
            "uri": f"sqlite:///{catalog_path}",
            "warehouse": f"file://{os.path.abspath(warehouse_dir)}",
        }
    )
    
    # Create namespace if it doesn't exist
    try:
        catalog.create_namespace("default")
    except Exception:
        pass  # Namespace might already exist
    
    return catalog


def import_parquet_files(catalog, table_name, schema, partition_spec, parquet_files, warehouse_dir):
    """Import existing Parquet files into an Iceberg table"""
    
    # Create or replace the table
    namespace = "default"
    table_identifier = f"{namespace}.{table_name}"
    
    try:
        # Try to drop existing table
        catalog.drop_table(table_identifier)
    except Exception:
        pass  # Table might not exist
    
    # Create the table with schema and partition spec
    table = catalog.create_table(
        identifier=table_identifier,
        schema=schema,
        partition_spec=partition_spec,
        properties={
            "write.format.default": "parquet",
            "write.parquet.compression-codec": "zstd",
        }
    )
    
    # For now, PyIceberg doesn't have a direct add_files API like Java Iceberg
    # We need to append data by reading and writing
    # This is a limitation of the current PyIceberg implementation
    
    print(f"  Adding {len(parquet_files)} Parquet files to table...")
    
    for i, parquet_file in enumerate(parquet_files, 1):
        try:
            # Read the Parquet file
            parquet_file_abs = os.path.abspath(parquet_file)
            arrow_table = pq.read_table(parquet_file_abs)
            
            # Append to Iceberg table
            # PyIceberg will manage the metadata and create proper Iceberg files
            table.append(arrow_table)
            
            if i % 10 == 0:
                print(f"    Processed {i}/{len(parquet_files)} files...")
        except Exception as e:
            print(f"    Warning: Failed to add {parquet_file}: {e}")
            continue
    
    print(f"  Successfully added files to Iceberg table")
    
    return table


def main():
    parser = argparse.ArgumentParser(
        description='Generate Apache Iceberg metadata using PyIceberg for AR.IO Parquet exports',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Requirements:
  pip install pyiceberg[pyarrow,duckdb,sql]

Examples:
  %(prog)s --warehouse-dir data/local/warehouse
  %(prog)s --warehouse-dir /path/to/warehouse --partition-size 5000
  
Query the generated tables:
  DuckDB (with PyIceberg catalog support):
    from pyiceberg.catalog.sql import SqlCatalog
    catalog = SqlCatalog('catalog', uri='sqlite:///data/local/warehouse/catalog.db', 
                         warehouse='file:///path/to/warehouse')
    table = catalog.load_table('default.blocks')
    
  Or with DuckDB Iceberg extension:
    INSTALL iceberg;
    LOAD iceberg;
    SELECT * FROM iceberg_scan('data/local/warehouse/blocks');
"""
    )
    
    parser.add_argument(
        '--warehouse-dir',
        default='data/local/warehouse',
        help='Warehouse directory containing Parquet data (default: data/local/warehouse)'
    )
    
    parser.add_argument(
        '--partition-size',
        type=int,
        default=1000,
        help='Height partition size for bucketing (default: 1000)'
    )
    
    args = parser.parse_args()
    
    # Check if warehouse directory exists
    if not os.path.exists(args.warehouse_dir):
        print(f"Error: Warehouse directory does not exist: {args.warehouse_dir}", file=sys.stderr)
        sys.exit(1)
    
    print(f"Generating Iceberg metadata using PyIceberg")
    print(f"Warehouse: {args.warehouse_dir}")
    print(f"Partition size: {args.partition_size}")
    print()
    
    # Create catalog
    try:
        catalog = create_local_catalog(args.warehouse_dir)
        print(f"Created/opened Iceberg catalog at: {args.warehouse_dir}/catalog.db")
    except Exception as e:
        print(f"Error creating catalog: {e}", file=sys.stderr)
        sys.exit(1)
    
    # Define partition spec (bucket by height)
    partition_spec = PartitionSpec(
        PartitionField(
            source_id=2,  # height field (field 2 in schema)
            field_id=1000,
            transform=BucketTransform(args.partition_size),
            name="height_bucket"
        )
    )
    
    # Process each table
    tables = [
        ("blocks", get_blocks_schema()),
        ("transactions", get_transactions_schema()),
        ("tags", get_tags_schema()),
    ]
    
    for table_name, schema in tables:
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
        
        try:
            # Import Parquet files into Iceberg table
            table = import_parquet_files(
                catalog, 
                table_name, 
                schema, 
                partition_spec, 
                parquet_files,
                args.warehouse_dir
            )
            print(f"  Created Iceberg table: default.{table_name}")
            print(f"  Table location: {table.location()}")
        except Exception as e:
            print(f"  Error creating table {table_name}: {e}")
            continue
    
    print()
    print("Iceberg metadata generation complete!")
    print(f"Catalog location: {args.warehouse_dir}/catalog.db")
    print()
    print("To query these tables:")
    print()
    print("Python with PyIceberg:")
    print("```python")
    print("from pyiceberg.catalog.sql import SqlCatalog")
    print(f"catalog = SqlCatalog('catalog', uri='sqlite:///{os.path.abspath(args.warehouse_dir)}/catalog.db',")
    print(f"                     warehouse='file://{os.path.abspath(args.warehouse_dir)}')")
    print("table = catalog.load_table('default.blocks')")
    print("df = table.scan().to_pandas()")
    print("```")
    print()
    print("DuckDB with Iceberg extension:")
    print("  duckdb")
    print("  INSTALL iceberg;")
    print("  LOAD iceberg;")
    print(f"  SELECT * FROM iceberg_scan('{args.warehouse_dir}/blocks/metadata/');")


if __name__ == '__main__':
    main()