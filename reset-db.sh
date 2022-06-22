#!/usr/bin/env bash

rm -f chain.db
sqlite3 chain.db < schema.sql
