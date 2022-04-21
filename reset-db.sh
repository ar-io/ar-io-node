#!/usr/bin/env bash

rm chain.db
sqlite3 chain.db < schema.sql
