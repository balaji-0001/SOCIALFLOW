#!/bin/bash
set -e
pnpm install --frozen-lockfile
# The API creates and updates the database tables itself when it starts.
