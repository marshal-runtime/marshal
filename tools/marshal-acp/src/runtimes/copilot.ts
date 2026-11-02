import type { SpawnConfig, SpawnConfigOpts } from "./index.ts";

// Copilot CLI exposes selective deny via `--deny-tool` flags (verified against
// `copilot --help` Jun 2026). Pattern syntax mirrors the example in the CLI
// help: `shell(<cmd>:*)`. --deny-tool takes precedence over --allow-tool.
//
// Tool name is `shell` (Copilot's equivalent of Claude's `Bash`).
// Each gh-pr-write entry duplicates the unprefixed shape ("* gh pr ...") so
// chained commands also match — Copilot's deny-tool patterns are first-argv
// anchored. The layer-2 regex in permission-policy.ts uses \b so it catches
// all chain forms.
const POLICY_DENY = [
  "shell(gh pr comment:*)",
  "shell(* gh pr comment:*)",
  "shell(gh pr review:*)",
  "shell(* gh pr review:*)",
  "shell(gh pr edit:*)",
  "shell(* gh pr edit:*)",
  "shell(gh pr merge:*)",
  "shell(* gh pr merge:*)",
  "shell(gh pr close:*)",
  "shell(* gh pr close:*)",
  "shell(gh pr ready:*)",
  "shell(* gh pr ready:*)",
  "shell(gh auth token:*)",
  "shell(* gh auth token:*)",
  "shell(gh api:*--method POST*)",
  "shell(gh api:*--method PATCH*)",
  "shell(gh api:*--method PUT*)",
  "shell(gh api:*--method DELETE*)",
  "shell(gh api:*-X POST*)",
  "shell(gh api:*-X PATCH*)",
  "shell(gh api:*-X PUT*)",
  "shell(gh api:*-X DELETE*)",
  // -f / --field / --raw-field flip gh's default method to POST without
  // requiring --method. Documented mechanism for passing form fields.
  "shell(gh api:*-f *)",
  "shell(gh api:*-F *)",
  "shell(gh api:*--field *)",
  "shell(gh api:*--raw-field *)",
  "shell(curl:*api.github.com*)",
  "shell(wget:*api.github.com*)",
];

export function copilotSpawnConfig(opts: SpawnConfigOpts): SpawnConfig {
  // winget / scoop install `copilot.exe` on Windows. Override via env var if
  // your install lays it down elsewhere (e.g. a `.cmd` shim under nvm).
  // Preserve the pre-rebrand override for existing local scripts.
  const override =
    process.env.MARSHAL_REVIEW_QUEUE_COPILOT_PATH ?? process.env.MARSHAL_REVIEW_QUEUE_COPILOT_PATH;
  const cmd =
    override && override.length > 0
      ? override
      : process.platform === "win32"
        ? "copilot.exe"
        : "copilot";

  // Build --deny-tool flags. Each pattern becomes its own flag.
  const denyFlags: string[] = [];
  for (const pat of POLICY_DENY) {
    denyFlags.push("--deny-tool", pat);
  }

  return {
    cmd,
    // --allow-all-tools is required for non-interactive ACP mode (Copilot CLI
    // can't prompt the user mid-session). --deny-tool overrides it for the
    // patterns we care about.
    args: ["--acp", "--allow-all-tools", ...denyFlags],
    env: {
      ...process.env,
      GH_TOKEN: "",
    },
    cwd: opts.cwd,
  };
}
