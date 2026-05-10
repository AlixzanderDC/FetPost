#!/usr/bin/env bash
# Called by the FetPost UI when you click "Refresh cookies" for an account.
# Opens a Chrome window where you log into FetLife manually; cookies are then saved.
cd "$(dirname "$0")"
node --env-file=../.env src/setup-cookies.js
