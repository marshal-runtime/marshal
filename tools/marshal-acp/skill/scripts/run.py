#!/usr/bin/env python3
"""Driver for the marshal-acp-prompt skill.

Shells out to the `marshal-acp` CLI (installed via `pnpm link --global` from the
repo root). Forwards a small set of flags and prints the resulting session
file path so callers can surface it.

Usage:
    python3 run.py --title <short label> --prompt <full prompt> \
                   [--runtime claude|copilot] \
                   [--profile review|default] \
                   [--cwd <path>] \
                   [--detach]
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--title", required=True, help="Short human-scannable label (4-8 words).")
    parser.add_argument("--prompt", required=True, help="The instruction the agent executes.")
    parser.add_argument("--runtime", choices=["claude", "copilot"], default=None)
    parser.add_argument("--profile", choices=["review", "default"], default=None)
    parser.add_argument("--cwd", default=None, help="Working directory for the spawned agent.")
    parser.add_argument(
        "--detach",
        action="store_true",
        help=(
            "Non-blocking. Spawn the session and return immediately with the "
            "session file path + resume/open commands. Check `marshal-acp show <file>` "
            "once the agent finishes (typically 10-60s)."
        ),
    )
    args = parser.parse_args()

    marshal_acp = shutil.which("marshal-acp")
    if not marshal_acp:
        print(
            "error: `marshal-acp` not found on PATH. From the Marshal repo root, run: "
            "pnpm install && pnpm link --global. Re-open the shell after linking.",
            file=sys.stderr,
        )
        return 2

    cmd = [marshal_acp, "prompt"]
    if args.runtime:
        cmd.extend(["--runtime", args.runtime])
    if args.profile:
        cmd.extend(["--profile", args.profile])
    if args.cwd:
        cmd.extend(["--cwd", args.cwd])
    if args.detach:
        cmd.append("--detach")
    cmd.extend([args.title, args.prompt])

    result = subprocess.run(cmd, check=False)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
