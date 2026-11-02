// Marshal-owned module.
import { createRequire } from "node:module";

import type { SpawnConfig, SpawnConfigOpts } from "./index.ts";

const require_ = createRequire(import.meta.url);

// Resolve the installed entry script directly and invoke it with our own node
// binary. This bypasses two real problems with `npx --yes`:
//
//   1. On Windows, spawning `npx.cmd` creates a cmd.exe -> npx -> node chain.
//      stdin/stdout don't reliably forward through that chain, so the ACP
//      child sits at `process.stdin.resume()` forever waiting for input we
//      already sent — slots hang indefinitely.
//   2. Every fresh invocation walks the npx network path (registry check,
//      cache layout). Spawning the resolved path directly is faster and
//      deterministic.
//
// `--disallowed-tools` is NOT a CLI flag of this adapter (v0.33.1); the only
// recognised flags are --cli and --hide-claude-auth. Tool blocking is handled
// by layer 1 (permission callback) and layer 3 (empty GH_TOKEN).
// Policy-tier deny rules forwarded into the Claude Agent SDK's permission
// layer. The model classifier in auto/default mode auto-approves shell tool
// calls it considers safe (verified: `gh pr comment` is auto-approved with
// zero permission requests surfaced to the ACP client). Putting deny rules
// here makes the SDK refuse to dispatch the tool before the classifier opines.
//
// We use `settings.permissions.deny` (user-layer) rather than
// `managedSettings.permissions.deny` (policy-layer): the managed-settings
// path is silently ignored when passed via `_meta.claudeCode.options` over
// ACP (probe Jun 2026 — `managedSettings: { permissions: { deny: ["Bash(*)"] } }`
// did NOT block `gh --version`, whereas the same rules under `settings` did).
//
// Pattern syntax is the Claude Code permission-rule glob form. Verified
// working: catch-all `Bash(*)` removes the Bash tool entirely. Selective
// patterns use `Bash(<command prefix>*)` — the trailing `*` is the wildcard.
// Each entry duplicates the unprefixed shape so chained commands ("cd /tmp
// && gh pr comment …") also match — the SDK's glob is prefix-anchored to
// the first argv segment, so we need both shapes to catch && / ; / | chains.
// The layer-2 regex in permission-policy.ts uses \b so it catches all chain
// forms; this layer 1 list is a wider net but glob-limited.
const POLICY_DENY = [
  "Bash(gh pr comment*)",
  "Bash(* gh pr comment*)",
  "Bash(gh pr review*)",
  "Bash(* gh pr review*)",
  "Bash(gh pr edit*)",
  "Bash(* gh pr edit*)",
  "Bash(gh pr merge*)",
  "Bash(* gh pr merge*)",
  "Bash(gh pr close*)",
  "Bash(* gh pr close*)",
  "Bash(gh pr ready*)",
  "Bash(* gh pr ready*)",
  "Bash(gh auth token*)",
  "Bash(* gh auth token*)",
  "Bash(gh api*--method POST*)",
  "Bash(gh api*--method PATCH*)",
  "Bash(gh api*--method PUT*)",
  "Bash(gh api*--method DELETE*)",
  "Bash(gh api*-X POST*)",
  "Bash(gh api*-X PATCH*)",
  "Bash(gh api*-X PUT*)",
  "Bash(gh api*-X DELETE*)",
  // -f / --field / --raw-field flip gh's default method to POST without
  // requiring --method. Documented mechanism for passing form fields.
  "Bash(gh api*-f *)",
  "Bash(gh api*-F *)",
  "Bash(gh api*--field *)",
  "Bash(gh api*--raw-field *)",
  "Bash(curl*api.github.com*)",
  "Bash(wget*api.github.com*)",
];

export function claudeSpawnConfig(opts: SpawnConfigOpts): SpawnConfig {
  const entry = require_.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
  return {
    cmd: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      GH_TOKEN: "",
    },
    cwd: opts.cwd,
    sessionMeta: {
      claudeCode: {
        options: {
          settings: {
            permissions: {
              deny: POLICY_DENY,
            },
          },
        },
      },
    },
  };
}
