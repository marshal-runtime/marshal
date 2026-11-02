#!/usr/bin/env bash
# Close a PR review tab inside the shared marshal-review Zellij session.
#
# Usage: bash close-tab.sh <pr-number>   # closes "PR-<pr-number>"
#        bash close-tab.sh --name NAME   # closes an arbitrary tab
#        bash close-tab.sh --all         # closes every PR-* tab
#
# Pattern: focus the named tab, then `action close-tab`.

set -euo pipefail

session="marshal-review"

if ! zellij list-sessions 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -qE "(^|[[:space:]])${session}([[:space:]]|$)"; then
  echo "error: session '${session}' is not running." >&2
  exit 1
fi

close_tab() {
  local name="$1"
  if ! zellij -s "$session" action query-tab-names 2>/dev/null | grep -Fx "$name" >/dev/null; then
    echo "warn: tab '${name}' not found." >&2
    return 1
  fi
  zellij -s "$session" action go-to-tab-name "$name" >/dev/null
  zellij -s "$session" action close-tab >/dev/null
  echo "closed: ${name}"
}

case "${1:-}" in
  "")
    echo "usage: $0 <pr-number>|--name NAME|--all" >&2
    exit 2
    ;;
  --all)
    mapfile -t tabs < <(zellij -s "$session" action query-tab-names 2>/dev/null | grep -E '^PR-[0-9]+$' || true)
    if [ "${#tabs[@]}" -eq 0 ]; then
      echo "no PR-* tabs to close."
      exit 0
    fi
    for t in "${tabs[@]}"; do
      close_tab "$t" || true
    done
    ;;
  --name)
    shift
    close_tab "${1:?--name requires a tab name}"
    ;;
  *)
    close_tab "PR-$1"
    ;;
esac
