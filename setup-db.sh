#!/usr/bin/env sh

DATABASE_DIR=data/sqlite
DATABASE_FILE=data/sqlite/code.db

mkdir -p data/sqlite

if [ ! -f "$DATABASE_FILE" ]; then
  sh reset-db.sh
fi
