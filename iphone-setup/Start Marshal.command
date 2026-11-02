#!/bin/zsh
set -eu
cd "${0:A:h}/.."
if [[ ! -f dist/remote.html || ! -f dist-electron/main.js ]]; then
  print 'The prepared build is missing. Run pnpm build:vite in the Marshal folder.'
  read '?Press Enter to close.'
  exit 1
fi
# Use the same development profile as the existing checkout launcher.
# The Electron single-instance lock prevents starting a competing copy.
unset ELECTRON_RUN_AS_NODE
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
node scripts/marshal-launch-electron.cjs
