#!/usr/bin/env sh

DATABASE_FILE=data/sqlite/code.db

if [ ! -f "$DATABASE_FILE" ]; then
  sh reset-db.sh
fi