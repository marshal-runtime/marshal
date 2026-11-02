#!/usr/bin/env bash
# Installs the formal-verification toolchain into a user cache (no sudo):
# a Temurin JDK 21 + tla2tools.jar for TLC, and Lean 4 via elan.
set -euo pipefail

tools_dir="${MARSHAL_FORMAL_TOOLS:-$HOME/.cache/marshal-formal}"
mkdir -p "$tools_dir"

case "$(uname -s)" in
  Darwin) jdk_os="mac" ;;
  Linux) jdk_os="linux" ;;
  *) echo "Unsupported OS $(uname -s); install a JDK 17+ and Lean 4 manually." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) jdk_arch="aarch64" ;;
  x86_64) jdk_arch="x64" ;;
  *) echo "Unsupported CPU $(uname -m)." >&2; exit 1 ;;
esac

if ! ls -d "$tools_dir"/jdk-* >/dev/null 2>&1; then
  echo "Downloading Temurin JDK 21 ($jdk_os/$jdk_arch)..."
  curl -fsSL -o "$tools_dir/jdk.tar.gz" \
    "https://api.adoptium.net/v3/binary/latest/21/ga/$jdk_os/$jdk_arch/jdk/hotspot/normal/eclipse"
  tar -xzf "$tools_dir/jdk.tar.gz" -C "$tools_dir"
  rm "$tools_dir/jdk.tar.gz"
fi

if [ ! -f "$tools_dir/tla2tools.jar" ]; then
  echo "Downloading tla2tools.jar..."
  curl -fsSL -o "$tools_dir/tla2tools.jar" \
    https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar
fi

if ! command -v lake >/dev/null 2>&1 && [ ! -x "$HOME/.elan/bin/lake" ]; then
  echo "Installing elan (Lean toolchain manager)..."
  curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
    -o "$tools_dir/elan-init.sh"
  sh "$tools_dir/elan-init.sh" -y --default-toolchain none --no-modify-path
fi

echo "Toolchain ready in $tools_dir (Lean via ~/.elan/bin)."
