#!/usr/bin/env bash
# Launch a Claude Code /marshal-code-review session for a OmerMachluf/marshal PR inside a Zellij pane.
#
# Usage:
#   bash launch-review.sh <pr-number>   # add/focus a tab for the given PR
#   bash launch-review.sh --reattach    # spawn a new visible client for an existing session
#
# Session: "marshal-review" (shared across invocations; each PR lands as a new tab)
#
# Behaviour:
#   - If the "marshal-review" Zellij session already exists: adds a new tab inside it
#     and the user sees it immediately if they're attached.
#   - If it doesn't exist: creates it detached (Windows: via `cmd /c start /B`
#     so the session persists after this script returns). The user then runs
#     `zellij attach marshal-review` to see it.
#   - --reattach mode (macOS only): spawns a new visible terminal window
#     attached to the existing session. Useful after closing a window and
#     wanting to get the orphaned session back on screen.
#
# Ported from dev-hub's launcher (packages/agent-bridge/src/launcher.ts ~L438).

set -euo pipefail

session="marshal-review"
reattach_mode=0
if [ "${1:-}" = "--reattach" ]; then
  reattach_mode=1
  pr=""
  tab=""
  url=""
else
  pr="${1:?usage: launch-review.sh <pr-number> | --reattach}"
  tab="PR-${pr}"
  url="https://github.com/OmerMachluf/marshal/pull/${pr}"
  shift  # consume pr; parse optional flags
  resume_session=""
  resume_runtime="claude"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --resume-session)
        shift
        resume_session="${1:?--resume-session requires a session id}"
        ;;
      --runtime)
        shift
        resume_runtime="${1:?--runtime requires a value}"
        ;;
      *)
        break
        ;;
    esac
    shift
  done
fi

# Repo root is derived from the script's own location: this script lives at
# <repo>/skills/marshal-review-dashboard/scripts/launch-review.sh.
# `cd -P` resolves symlinks, so invocations via `pnpm install:skills` links
# (e.g. .claude/skills/marshal-review-dashboard -> skills/marshal-review-dashboard) still
# compute the real repo root, not the symlink's parent directory.
# Overridable via $MARSHAL_REPO for odd invocations (e.g. tests); keep the
# pre-rebrand variable as a fallback for existing local scripts.
script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cwd="${MARSHAL_REPO:-${MARSHAL_REPO:-$(cd -P "$script_dir/../../.." && pwd)}}"

is_windows=0
is_mac=0
case "${OSTYPE:-}" in
  msys*|cygwin*|win32*) is_windows=1 ;;
  darwin*) is_mac=1 ;;
esac

# Resolve zellij.exe once, regardless of install location. `command -v` in Git
# Bash returns the POSIX-form path; cygpath translates it to Windows form for
# the .cmd wrapper below.
zellij_posix="$(command -v zellij || true)"
if [ -z "$zellij_posix" ]; then
  case "${OSTYPE:-}" in
    darwin*) echo "error: zellij not found. Install with: brew install zellij" >&2 ;;
    msys*|cygwin*|win32*) echo "error: zellij not found. Install with: scoop install zellij" >&2 ;;
    *) echo "error: zellij not found on PATH." >&2 ;;
  esac
  exit 1
fi

# Git Bash bin dir — we prepend it to PATH inside the .cmd wrapper so zellij's
# spawned `bash` resolves to Git Bash, not WSL's /bin/bash (incompatible
# filesystem view). `command -v bash` in Git Bash points at /usr/bin/bash;
# cygpath -w converts the containing dir to Windows form.
bash_posix="$(command -v bash || true)"
if [ "$is_windows" = "1" ] && [ -z "$bash_posix" ]; then
  echo "error: bash not found on PATH." >&2
  exit 1
fi

# On Windows git-bash, MSYS2 rewrites POSIX-looking args (/marshal-code-review, URL
# paths) to Windows paths when bash spawns claude.exe. Disable for this subtree
# so the slash command and URL survive intact.
msys_prefix=""
if [ "$is_windows" = "1" ]; then
  msys_prefix="export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' && "
fi

# Forward slashes survive git-bash path handling better than backslashes.
posix_cwd="${cwd//\\//}"

# The command that runs inside the new pane.
if [ -n "${resume_session:-}" ]; then
  case "$resume_runtime" in
    claude)  inner_resume=$(printf 'claude --resume %s' "$resume_session") ;;
    copilot) inner_resume=$(printf 'copilot --resume %s' "$resume_session") ;;
    *) echo "error: unknown --runtime '$resume_runtime' (expected claude|copilot)" >&2; exit 1 ;;
  esac
  agent_cmd="${msys_prefix}cd \"${posix_cwd}\" && ${inner_resume}"
else
  agent_cmd="${msys_prefix}cd \"${posix_cwd}\" && claude --name \"${tab}\" \"/marshal-code-review ${url}\""
fi

# Helper: spawn a visible macOS terminal window running the given argv.
# Used by both the cold-start path (zellij --new-session-with-layout) and
# --reattach (zellij attach). Resolves the terminal app from the same
# precedence chain ($MARSHAL_REVIEW_TERMINAL → $TERMINAL → /Applications probe)
# and forks per-app launch syntax. Sets $terminal_app for the caller's hint.
spawn_mac_terminal() {
  local prog="$1"
  shift

  terminal_app=""
  if [ -n "${MARSHAL_REVIEW_TERMINAL:-${MARSHAL_REVIEW_TERMINAL:-}}" ]; then
    terminal_app="${MARSHAL_REVIEW_TERMINAL:-$MARSHAL_REVIEW_TERMINAL}"
  elif [ -n "${TERMINAL:-}" ]; then
    terminal_app="$(basename "$TERMINAL")"
  else
    # Terminal.app ships under /System/Applications/Utilities on modern macOS
    # (and historically /Applications/Utilities), not /Applications. Probe
    # those locations specifically so a vanilla Mac with no third-party
    # terminal still resolves the built-in.
    local candidate
    for candidate in Ghostty iTerm Terminal; do
      if [ "$candidate" = "Terminal" ]; then
        if [ -d "/System/Applications/Utilities/Terminal.app" ] \
            || [ -d "/Applications/Utilities/Terminal.app" ]; then
          terminal_app="$candidate"
          break
        fi
      elif [ -d "/Applications/${candidate}.app" ]; then
        terminal_app="$candidate"
        break
      fi
    done
  fi

  if [ -z "$terminal_app" ]; then
    echo "error: no terminal app found. Set MARSHAL_REVIEW_TERMINAL=<Ghostty|iTerm|Terminal>" \
         "or install one of: Ghostty, iTerm, Terminal." >&2
    return 1
  fi

  # Shell-quoted form for AppleScript / .command wrapper which take a single
  # command-line string. Our paths and session names contain no spaces, so a
  # naive join is safe.
  local cmd_str="$prog"
  local arg
  for arg in "$@"; do
    cmd_str="$cmd_str $arg"
  done

  case "$terminal_app" in
    Ghostty|ghostty)
      # Ghostty's CLI binary is not supported as a launch vector on macOS;
      # use `open -na` per the official guidance. -e takes the rest of argv
      # as program + args, so each piece must be a separate `--args` element.
      open -na Ghostty.app --args -e "$prog" "$@"
      ;;
    iTerm|iTerm2|iterm|iterm2)
      osascript <<EOF_OSA
tell application "iTerm"
  activate
  create window with default profile command "$cmd_str"
end tell
EOF_OSA
      ;;
    Terminal|terminal)
      # Terminal.app natively executes .command files in a new window. Keep
      # the wrapper around for Terminal's "press Return to relaunch" feature.
      local wrapper
      wrapper="$(mktemp -t m-review-wrap.XXXXXX)"
      mv "$wrapper" "${wrapper}.command"
      wrapper="${wrapper}.command"
      cat > "$wrapper" <<EOF_WRAP
#!/usr/bin/env bash
exec ${cmd_str}
EOF_WRAP
      chmod +x "$wrapper"
      open -a Terminal "$wrapper"
      ;;
    *)
      echo "error: unsupported terminal '${terminal_app}'." \
           "Supported: Ghostty, iTerm, Terminal." >&2
      return 1
      ;;
  esac
}

# --- Session existence check ----------------------------------------------
# zellij list-sessions output has ANSI color codes; strip them before matching.
strip_ansi() {
  sed 's/\x1b\[[0-9;]*m//g'
}

sessions_raw="$(zellij list-sessions 2>/dev/null || true)"
session_exists=0
session_exited=0
while IFS= read -r line; do
  stripped="$(printf '%s' "$line" | strip_ansi)"
  trimmed="$(printf '%s' "$stripped" | sed 's/^[[:space:]]*//')"
  case "$trimmed" in
    "$session "*|"$session")
      if printf '%s' "$stripped" | grep -q "EXITED"; then
        # Zombie session — still holds the name, so a fresh
        # `--new-session-with-layout` with the same name would silently fail
        # ("session already exists"). Flag it so the create path can purge
        # before launching.
        session_exited=1
      else
        session_exists=1
      fi
      break
      ;;
  esac
done <<EOF_SESSIONS
$sessions_raw
EOF_SESSIONS

# --- Reattach mode: spawn a new visible client for the existing session ---
# The regular session-exists path below uses `zellij action` against the
# daemon, which works fine when you already have a window attached but
# silently no-ops (visually) if you've closed all clients. --reattach is
# the recovery path: bring an orphaned session back on screen.
if [ "$reattach_mode" = "1" ]; then
  if [ "$session_exists" != "1" ]; then
    echo "error: zellij session '$session' is not running. Launch a PR first." >&2
    exit 1
  fi
  if [ "$is_mac" != "1" ]; then
    echo "error: --reattach is currently only supported on macOS." >&2
    exit 1
  fi
  spawn_mac_terminal "$zellij_posix" attach "$session"
  echo "Reattached to '$session' in a new ${terminal_app} window."
  exit 0
fi

# --- Attach path: session exists -> focus existing tab, or add a new one --
if [ "$session_exists" = 1 ]; then
  existing_tabs="$(zellij -s "$session" action query-tab-names 2>/dev/null || true)"
  if printf '%s\n' "$existing_tabs" | grep -Fx "$tab" >/dev/null; then
    echo "Session '${session}' is live. Tab '${tab}' already exists — focusing it."
    exec zellij -s "$session" action go-to-tab-name "$tab"
  fi
  echo "Session '${session}' is live. Adding tab '${tab}'."
  exec zellij -s "$session" action new-tab \
    --name "$tab" \
    --cwd "$cwd" \
    -- bash -c "$agent_cmd"
fi

# --- Create path: no live session -> write a layout and spawn detached ----
# A zombie session (EXITED, "attach to resurrect") still owns the name and
# would block `--new-session-with-layout`. Purge first so the create call has
# a clean slot. `--force` skips the interactive y/N prompt; failure here is
# non-fatal because the next launch attempt will just hit the same error
# more visibly.
if [ "$session_exited" = "1" ]; then
  echo "Session '${session}' is EXITED — purging before recreating."
  zellij delete-session "$session" --force >/dev/null 2>&1 || true
fi

echo "Session '${session}' not running. Creating it (detached)."

# Match dev-hub's layout shape exactly: pane command="bash", args "-c" "<cmd>".
# The wrapper .cmd below prepends Git\bin to PATH so the `bash` zellij spawns
# is Git Bash (not WSL's /bin/bash, which would mis-resolve /c/... paths).
layout_file="$(mktemp -t marshal-review.XXXXXX)"
mv "$layout_file" "${layout_file}.kdl"
layout_file="${layout_file}.kdl"

escaped_cmd="${agent_cmd//\\/\\\\}"
escaped_cmd="${escaped_cmd//\"/\\\"}"
# Zellij forbids mixing plugin panes and `tab` nodes at the top level of a
# layout. Use `default_tab_template` so every tab (now and in future) is
# wrapped with a tab-bar at the top and a status-bar at the bottom.
cat > "$layout_file" <<EOF_LAYOUT
layout {
    default_tab_template {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        children
        pane size=2 borderless=true {
            plugin location="zellij:status-bar"
        }
    }
    tab name="${tab}" {
        pane command="bash" {
            args "-c" "${escaped_cmd}"
        }
    }
}
EOF_LAYOUT

if [ "$is_windows" = "1" ]; then
  # Windows Terminal provides the visible display surface for Zellij. Bail
  # early if it isn't installed rather than silently doing nothing.
  if ! command -v wt.exe >/dev/null 2>&1; then
    echo "error: wt.exe (Windows Terminal) not found on PATH. Install from the" \
         "Windows store, or attach manually with: zellij attach -c ${session}" >&2
    exit 1
  fi

  # Spawn a new Windows Terminal window that *visibly* runs Zellij with the
  # layout we just wrote. WT provides the display surface that Zellij needs;
  # the user sees the tab + Claude Code immediately. Layout path must be in
  # Windows form so zellij (a native .exe) can resolve it.
  #
  # Notes:
  # - WT's argument parser mishandles both trailing args (treats `-s` as its
  #   own flag) and --commandline (treats the whole string as one filename).
  #   Reliable workaround: generate a tiny .cmd wrapper that invokes zellij
  #   and have WT run just that one file path. No quoting traps.
  # - Paths must be Windows-form because zellij is a native .exe.
  layout_win="$(cygpath -w "$layout_file")"
  cwd_win="$(cygpath -w "$cwd")"
  zellij_win="$(cygpath -w "$zellij_posix")"
  bash_dir_win="$(cygpath -w "$(dirname "$bash_posix")")"

  wrapper_file="$(mktemp -t m-review-wrap.XXXXXX)"
  mv "$wrapper_file" "${wrapper_file}.cmd"
  wrapper_file="${wrapper_file}.cmd"
  wrapper_win="$(cygpath -w "$wrapper_file")"
  # Prepend Git Bash's bin dir so zellij-inside-cmd resolves `bash` to Git
  # Bash rather than WSL's /bin/bash (they have incompatible views of the
  # filesystem). Backslashes in the path survive cmd's escaping because we
  # double-quote the assignment.
  cat > "$wrapper_file" <<EOF_WRAP
@echo off
set "PATH=${bash_dir_win};%PATH%"
"${zellij_win}" -s ${session} --new-session-with-layout "${layout_win}"
EOF_WRAP

  wt.exe -w new new-tab --title "${session}" --startingDirectory "${cwd_win}" \
    "${wrapper_win}" \
    >/dev/null 2>&1 &
  disown || true
elif [ "$is_mac" = "1" ]; then
  # macOS: the launcher is typically invoked from a non-terminal context (e.g.
  # Claude Code), so we need to spawn a *visible* terminal window — the same
  # role Windows Terminal plays on the Windows path. spawn_mac_terminal
  # handles the terminal-app detection and per-app launch syntax.
  spawn_mac_terminal "$zellij_posix" -s "$session" --new-session-with-layout "$layout_file"
else
  # Linux: the user's current terminal is the display. Background zellij so
  # the calling shell stays responsive; user attaches manually with
  # `zellij attach marshal-review`.
  if command -v setsid >/dev/null 2>&1; then
    ( setsid zellij -s "$session" --new-session-with-layout "$layout_file" </dev/null >/dev/null 2>&1 & )
  else
    ( zellij -s "$session" --new-session-with-layout "$layout_file" </dev/null >/dev/null 2>&1 & )
  fi
fi

# Poll list-sessions until the session registers (up to ~10s).
for _ in $(seq 1 40); do
  sleep 0.25
  if zellij list-sessions 2>/dev/null | strip_ansi | grep -qE "(^|[[:space:]])${session}([[:space:]]|$)"; then
    break
  fi
done

# Keep layout + wrapper around for inspection when debugging.
if [ "${LAUNCH_REVIEW_DEBUG:-0}" = "1" ]; then
  echo "debug: layout=${layout_file}"
  echo "debug: wrapper=${wrapper_file:-<none>}"
elif [ "$is_mac" = "1" ]; then
  # macOS: cold-starting a terminal app via `open -na` can exceed the polling
  # window (Ghostty first-launch is multiple seconds), and the layout file
  # must still exist when zellij finally boots. Leave layout + wrapper in
  # $TMPDIR for the OS to clean up.
  :
else
  sleep 0.5
  rm -f "$layout_file" 2>/dev/null || true
  # Do NOT delete the wrapper file: Windows Terminal and Terminal.app retain a
  # reference to it for their "press Enter to restart" feature. If the zellij
  # session later dies and the user tries to restart from the tab, the wrapper
  # must still exist. The OS cleans %TEMP% / $TMPDIR eventually.
fi

if [ "$is_windows" = "1" ]; then
  display_app="Windows Terminal"
elif [ "$is_mac" = "1" ]; then
  display_app="${terminal_app}"
else
  display_app="your terminal (run: zellij attach ${session})"
fi

cat <<EOF_HINT
Session '${session}' started in a new ${display_app} window with tab '${tab}'.
Subsequent PRs launched via this script will add new tabs to the same session.
EOF_HINT
