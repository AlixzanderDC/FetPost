#!/usr/bin/env bash
# Called by the FetPost UI when you click "Refresh cookies" for an account.
# First arg (optional): accountId to target. If omitted, all accounts are processed.
cd "$(dirname "$0")"
node --env-file=../.env src/setup-cookies.js "$@"
