#!/bin/bash
# Marshal-owned path
# Build script that handles the flaky hdiutil "Resource busy" issue on macOS.
# Cleans up stale DMG mounts before building and retries on failure.

set -e

MAX_RETRIES=3
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

cleanup_dmg_mounts() {
  # Detach any lingering DMG mounts from previous failed builds
  # Look for hdiutil-created disk images (not real volumes like "Macintosh HD")
  hdiutil info 2>/dev/null | grep '/dev/disk' | awk '{print $1}' | while read dev; do
    echo "⚠ Found mounted disk image: $dev — detaching..."
    hdiutil detach "$dev" -force 2>/dev/null || true
    sleep 1
  done
}

attempt=1
while [ $attempt -le $MAX_RETRIES ]; do
  echo "▶ Build attempt $attempt/$MAX_RETRIES"
  cleanup_dmg_mounts

  if pnpm run build 2>&1; then
    echo "✅ Build succeeded on attempt $attempt"
    exit 0
  fi

  echo "❌ Build failed on attempt $attempt"
  cleanup_dmg_mounts
  sleep 3
  attempt=$((attempt + 1))
done

echo "💀 Build failed after $MAX_RETRIES attempts"
exit 1
