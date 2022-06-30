#!/usr/bin/env bash

rm -f data/sqlite/standalone.db
sqlite3 data/sqlite/standalone.db < schema.sql
