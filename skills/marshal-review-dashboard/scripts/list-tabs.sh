#!/usr/bin/env bash
# Show the tabs in the shared marshal-review Zellij session, one per line.
# Works from anywhere — no need to be attached to the session.

set -euo pipefail

session="marshal-review"

# zellij list-sessions output has ANSI color codes around names; strip before matching.
if ! zellij list-sessions 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -qE "(^|[[:space:]])${session}([[:space:]]|$)"; then
  echo "Session '${session}' is not running." >&2
  exit 1
fi

zellij -s "$session" action query-tab-names
