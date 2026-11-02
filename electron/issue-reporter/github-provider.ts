/**
 * GitHub adapter for {@link IssueReporterProvider}.
 *
 * The only file in the bug-reporting stack that knows about `gh`, repos, or
 * github.com. The destination comes from neutral local configuration
 * (`electron/issue-reporter/config.ts`) — never hardcoded here.
 */

import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";

import type { PermissionsConfig } from "../../common/marshal-ipc-contract";
import type {
  InvestigationProfile,
  IssueReport,
  IssueReporterAvailability,
  IssueReporterProvider,
} from "./provider";

export interface GhRunner {
  /** Returns true when `gh` exists on PATH and is authenticated. */
  isAvailable: () => Promise<boolean>;
  /** Returns true when the authenticated user can read the given repo. Used by
   *  the feature gate so we don't offer "Report a bug" to users outside the
   *  org who'd have nowhere to file the issue. */
  canAccessRepo: (repoTarget: string) => Promise<boolean>;
  /** Runs `gh issue create` against the given repo. Resolves with the new
   *  issue URL on success, or rejects on failure. */
  createIssue: (input: { title: string; body: string; repoTarget: string }) => Promise<string>;
}

export interface GitHubIssueReporterOptions {
  /** Neutral destination resolver — see `resolveIssueReporterTarget`. */
  getTarget: () => string | null;
  /** Override for `gh` discovery / spawning. Test seam. */
  ghRunner?: GhRunner;
}

export function createGitHubIssueReporter(
  options: GitHubIssueReporterOptions,
): IssueReporterProvider {
  const gh = options.ghRunner ?? defaultGhRunner();
  return {
    id: "github",
    displayName: "GitHub",
    getTarget: () => options.getTarget(),
    async checkAvailability(): Promise<IssueReporterAvailability> {
      const repoTarget = options.getTarget();
      if (!repoTarget) {
        return { available: false, reason: "No issue destination is configured" };
      }
      if (!(await gh.isAvailable())) {
        return { available: false, reason: "gh CLI is not installed or not authenticated" };
      }
      if (!(await gh.canAccessRepo(repoTarget))) {
        return { available: false, reason: `No access to ${repoTarget}` };
      }
      return { available: true };
    },
    async createIssue(report: IssueReport): Promise<string> {
      const repoTarget = requireTarget(options.getTarget());
      return gh.createIssue({ title: report.title, body: report.body, repoTarget });
    },
    buildFallbackUrl(report: IssueReport): string | null {
      const repoTarget = options.getTarget();
      if (!repoTarget) return null;
      return buildFallbackIssueUrl(report.title, report.body, repoTarget);
    },
    buildInvestigationProfile(): InvestigationProfile | null {
      const repoTarget = options.getTarget();
      if (!repoTarget) return null;
      return {
        instructions: buildGitHubInvestigationInstructions(repoTarget),
        permissions: buildGitHubInvestigationPermissions(repoTarget),
      };
    },
  };
}

function requireTarget(target: string | null): string {
  if (!target) throw new Error("No issue destination is configured");
  return target;
}

/** Belt-and-suspenders for the broad `gh api repos/<repoTarget>/*` allow.
 *  Patterns are evaluated at policy step 4c and win over the allow list.
 *  Each dangerous flag has two pattern variants:
 *    - "gh api -X*" — flag immediately after the subcommand
 *    - "gh api * -X*" — flag smuggled after the path positional */
const DENY_GH_API_FLAGS = [
  "gh api -X*",
  "gh api * -X*",
  "gh api --method*",
  "gh api *--method*",
  "gh api -F*",
  "gh api * -F*",
  "gh api --field*",
  "gh api *--field*",
  "gh api -f*",
  "gh api * -f*",
  "gh api --raw-field*",
  "gh api *--raw-field*",
  "gh api --input*",
  "gh api *--input*",
] as const;

/** Code-investigation allowlist, built dynamically against the configured
 *  repo target. Scope: dig into source code and history, not triage the
 *  issue tracker.
 *
 *  Effective policy:
 *    - Only the specific read-only `gh` subcommands listed below auto-approve.
 *      Anything else — including `gh issue/pr` triage, `gh search issues/prs`,
 *      destructive verbs, and unscoped `gh api` — falls through to the prompt
 *      tier and is rejected by setDenyPrompt.
 *    - `gh api repos/<repoTarget>/*` is allowed for read-only REST calls.
 *      `denyPatterns` reject any `gh api` invocation that includes
 *      method-changing / body-sending flags.
 *    - autoApproveReadOnly is OFF, so generic read-only commands like
 *      `grep`/`cat`/`git log` go to prompt → setDenyPrompt rejects them.
 *      End users have no local checkout of the repo; the AI must do
 *      all repo lookups via `gh` against GitHub.com.
 *    - Filesystem and Playwright MCPs are disabled outright.
 *
 *  We deliberately do NOT include `gh issue/pr list/view/diff` or
 *  `gh search issues/prs/repos`: scouring the issue tracker for
 *  duplicates is a human task; results are noisy and waste budget.
 *
 *  NOTE: `gh issue create` (the actual posting) runs as a direct
 *  child_process spawn from `defaultGhRunner.createIssue`, OUTSIDE the
 *  session, so it bypasses this allowlist entirely. */
export function buildGitHubInvestigationPermissions(repoTarget: string): PermissionsConfig {
  return {
    autoApproveReadOnly: false,
    allow: [
      "gh search code*",
      "gh search commits*",
      "gh repo view*",
      `gh api repos/${repoTarget}/*`,
    ],
    denyPatterns: [...DENY_GH_API_FLAGS],
    tools: {},
    servers: {
      filesystem: { enabled: false, autoApprove: false },
      playwright: { enabled: false, autoApprove: false },
      shell: { enabled: true, autoApprove: false },
    },
  };
}

/** Research instructions for a GitHub destination, with the caller-supplied
 *  `repoTarget` interpolated wherever the repo is referenced.
 *
 *  Previously these instructions lived in `first-party-skills/ai-investigator/SKILL.md`
 *  and were resolved at runtime via `getSkill`. That added a brittle delivery
 *  chain (first-party-skills → prebuild → bundled-skills → electron-builder
 *  → initBundledSkills → ~/.marshal/skills/) that has already broken once in
 *  production (v0.22.0 shipped without the skill installed, causing every
 *  investigation to fail). The skill was pure prose with no scripts or
 *  resources and only one caller — so we inline + templatize it here instead. */
export function buildGitHubInvestigationInstructions(repoTarget: string): string {
  return [
    `You are running in a hidden background session triggered when a user clicks the "Report a bug" button in Marshal. Your job: take the user's one-line description plus their attached diagnostics and produce a **structured markdown report** that the user will file verbatim as a GitHub issue against \`${repoTarget}\`.`,
    "",
    "**Your focus is code investigation.** Your value comes from reading the actual source — files, commit history, recent diffs — and pinning the bug to a likely location for the technical team. You are **not** a duplicate-issue search bot: finding similar GitHub issues is a human task and is not in your toolkit. Spend your budget reading code, not browsing the issue tracker.",
    "",
    "## Rules",
    "",
    `1. **You have NO local checkout of the repo.** End users run Marshal without a clone of \`${repoTarget}\`. Every repo lookup MUST go through the \`gh\` CLI talking to GitHub.com. Do **not** call \`git\`, \`grep\`, \`cat\`, \`ls\`, \`find\`, \`rg\`, or any local-filesystem tool — they will be denied, and even if they weren't, they would read whatever happens to be in the user's working directory (which is not the repo). Do **not** use the filesystem MCP — it is disabled.`,
    "",
    "2. **You MUST be strictly read-only.** Never write, delete, mutate, or call any tool that has side effects. Never open a browser. Never call `gh issue create`, `gh pr create`, `gh repo clone`, `gh repo fork`, `gh api -X POST/PUT/PATCH/DELETE`, or any other `gh` write sub-command.",
    "",
    "3. **Allowed tools** (everything else is auto-denied at the permission layer):",
    "",
    "   **Code search & history:**",
    `   - \`gh search code --repo ${repoTarget} '<query>'\` — full-text search across the repo. Your primary tool. Use it like grep. Returns file path + line snippet for up to ~100 hits.`,
    `   - \`gh search commits --repo ${repoTarget} '<query>'\` — find commits whose message or content matches; useful for "when did this break?"`,
    "",
    "   **Repo metadata (rarely needed):**",
    `   - \`gh repo view ${repoTarget}\` — confirm default branch, basic info.`,
    "",
    `   **REST API (read-only, scoped to ${repoTarget}):**`,
    `   - \`gh api repos/${repoTarget}/git/trees/HEAD?recursive=1\` — full file listing (the \`find\`-equivalent). Cheap, one call, lets you locate files by path pattern via \`--jq\`.`,
    `   - \`gh api repos/${repoTarget}/contents/<path>\` — read any file at HEAD (returns base64 in \`.content\`; pipe through \`base64 -d\`). Add \`?ref=<sha>\` to read it at a specific commit.`,
    `   - \`gh api repos/${repoTarget}/commits?path=<path>\` — per-file history (substitute for \`git log <file>\`).`,
    `   - \`gh api repos/${repoTarget}/commits/<sha>\` — full diff of a commit (substitute for \`git show <sha>\`).`,
    "   - You **must NOT** pass `-X`/`--method`/`-F`/`--field`/`-f`/`--raw-field`/`--input` — those flags are auto-denied at the permission layer (whether placed before or after the path) and your call will fail. Use only flags like `--jq`, `--paginate`, `--header`.",
    "",
    "   **Explicitly NOT allowed** (denied without prompting): `gh issue *`, `gh pr *`, `gh search issues|prs|repos`, `gh release *`, `gh workflow *`, `gh run *`, `gh label *`, `gh auth *`, `gh repo` subcommands other than `view`. Don't try them — those denials will eat your time budget.",
    "",
    "4. **Permission requests are silently denied.** The user is not present — any tool call that would prompt for permission will be auto-blocked. If a tool you wanted to use is denied, just skip it and proceed with what you already have.",
    "",
    "5. **Do not contact the user.** You will not get a reply. Use what's in the prompt + what you can fetch via `gh`.",
    "",
    "6. **Time budget: ~2 minutes.** Be concise. A typical efficient run looks like:",
    "   1. Read the diagnostics — usually they pinpoint a file:line. If so, skip search and go straight to step 3.",
    "   2. If the cause is unclear, run 1–3 targeted `gh search code` calls on distinctive identifiers from the error.",
    "   3. Pull the 1–5 most relevant files via `gh api .../contents/<path>` and read them carefully.",
    "   4. If a recent regression is suspected, check `gh api .../commits?path=<file>` and read the top commit's diff.",
    "   5. Write the report.",
    "",
    "   Do **not** spend cycles on `gh search issues`/`gh issue list` looking for duplicates — those tools are denied and the search would be noise anyway. If the diagnostics already plainly explain the bug, write the report immediately; you do not need to fetch anything.",
  ].join("\n");
}

// ── gh runner (cross-platform) ───────────────────────────────────────────────

export function defaultGhRunner(): GhRunner {
  return {
    isAvailable: () => detectGhAvailable(),
    canAccessRepo: (repoTarget) => detectRepoAccess(repoTarget),
    createIssue: async ({ title, body, repoTarget }) => {
      // Use a temp file for the body to avoid argv length limits & quoting issues.
      const dir = mkdtempSync(path.join(tmpdir(), "marshal-issue-reporter-"));
      const bodyFile = path.join(dir, "body.md");
      writeFileSync(bodyFile, body, "utf8");
      try {
        const stdout = await runGh([
          "issue",
          "create",
          "--repo",
          repoTarget,
          "--title",
          title,
          "--body-file",
          bodyFile,
        ]);
        // gh prints the new issue URL on stdout.
        const url = stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find((s) => s.startsWith("https://"));
        if (!url) throw new Error(`gh did not return an issue URL: ${stdout.slice(0, 200)}`);
        return url;
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    },
  };
}

async function detectGhAvailable(): Promise<boolean> {
  // Step 1: locate the binary.
  try {
    await runLocator("gh");
  } catch {
    return false;
  }
  // Step 2: confirm auth.
  try {
    await runGh(["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

async function detectRepoAccess(repoTarget: string): Promise<boolean> {
  // `gh repo view` exits 0 when the authenticated user can read the repo,
  // non-zero when they can't (404/private/no auth). Cheap and definitive.
  try {
    await runGh(["repo", "view", repoTarget, "--json", "name"]);
    return true;
  } catch {
    return false;
  }
}

/** Spawn `gh` with the given args. The binary is a string literal — no
 *  caller can substitute a different command. */
function runGh(args: string[]): Promise<string> {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- literal binary "gh", caller controls args only
  return spawnCapture(spawn("gh", args, { windowsHide: true, shell: false }), "gh");
}

/** Look up an executable on PATH. `target` must be a bare identifier
 *  (no path separators, no flags) — we validate before spawning so the
 *  command line cannot be coerced into something else. */
function runLocator(target: string): Promise<string> {
  if (!/^[a-z0-9._-]+$/i.test(target)) {
    return Promise.reject(new Error(`Invalid locator target: ${target}`));
  }
  if (process.platform === "win32") {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- literal binary "where.exe", target validated above
    return spawnCapture(
      spawn("where.exe", [target], { windowsHide: true, shell: false }),
      "where.exe",
    );
  }
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- literal binary "which", target validated above
  return spawnCapture(spawn("which", [target], { windowsHide: true, shell: false }), "which");
}

/** Captures stdout/stderr from an already-spawned child and resolves
 *  with stdout when the process exits 0. Takes a name purely for error
 *  message attribution — the actual binary is fixed by the caller. */
function spawnCapture(child: ReturnType<typeof spawn>, name: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${name} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

/** Hard cap GitHub honours for the prefilled new-issue URL body. */
const FALLBACK_BODY_MAX_BYTES = 6500;

export function buildFallbackIssueUrl(title: string, body: string, repoTarget: string): string {
  let safeBody = body;
  if (Buffer.byteLength(body, "utf8") > FALLBACK_BODY_MAX_BYTES) {
    // head-truncate to keep it inside browser URL limits
    let lo = 0;
    let hi = body.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (Buffer.byteLength(body.slice(0, mid), "utf8") <= FALLBACK_BODY_MAX_BYTES - 64) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    safeBody = body.slice(0, lo) + "\n\n…[truncated]…";
  }
  const params = new URLSearchParams({ title, body: safeBody });
  return `https://github.com/${repoTarget}/issues/new?${params.toString()}`;
}
