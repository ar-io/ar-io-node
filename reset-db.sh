#!/usr/bin/env bash

rm -f data/sqlite/core.*
sqlite3 data/sqlite/core.db < schema.sql
