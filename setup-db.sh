#!/usr/bin/env sh

DATABASE_DIR=data/sqlite
DATABASE_FILE=data/sqlite/code.db

if [ ! -f "$DATABASE_DIR" ]; then
  mkdir -p data/sqlite
fi

if [ ! -f "$DATABASE_FILE" ]; then
  sh reset-db.sh
fi