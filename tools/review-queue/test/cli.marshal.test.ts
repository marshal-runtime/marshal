// Marshal-owned tooling test.
import { describe, it, expect } from "vitest";

import { buildProgram, claudeSessionPath, findResumableIteration } from "../src/marshal-review-queue-cli.ts";

/** Run commander against an in-memory argv and capture stdout/stderr + exit
 *  state. Uses commander's `exitOverride()` so unknown commands and `--help`
 *  throw instead of calling `process.exit`, letting us assert on outcomes.
 *  Output config + exit override are applied to every subcommand because
 *  commander 14 doesn't cascade them automatically. */
function runProgram(argv: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  errorMessage: string;
} {
  const program = buildProgram();
  let exitCode: number | undefined;
  let errorMessage = "";
  let stdout = "";
  let stderr = "";

  const output = {
    writeOut: (s: string) => {
      stdout += s;
    },
    writeErr: (s: string) => {
      stderr += s;
    },
  };
  const onExit = (err: { exitCode: number; message: string }): never => {
    exitCode = err.exitCode;
    errorMessage = err.message;
    throw err;
  };

  program.exitOverride(onExit);
  program.configureOutput(output);
  for (const sub of program.commands) {
    sub.exitOverride(onExit);
    sub.configureOutput(output);
  }

  try {
    program.parse(["node", "cli.ts", ...argv]);
  } catch {
    // Swallowed — we read exit state via the closure above.
  }

  return { stdout, stderr, exitCode, errorMessage };
}

describe("cli — commander wiring", () => {
  it("--help lists every command we ship", () => {
    const out = runProgram(["--help"]);
    expect(out.exitCode).toBe(0);
    const commands = [
      "ensure",
      "tick",
      "status",
      "show",
      "resume",
      "confirm",
      "dismiss",
      "requeue",
      "cancel",
      "keep-context",
      "stop",
      "logs",
    ];
    for (const cmd of commands) {
      expect(out.stdout).toContain(cmd);
    }
  });

  it("--version exits 0 and prints a semver-shaped string", () => {
    const out = runProgram(["--version"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it("rejects unknown commands with a non-zero exit", () => {
    const out = runProgram(["bogus"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr + out.errorMessage).toMatch(/unknown command|bogus/i);
  });

  it("keep-context --help shows the extended explanation", () => {
    const out = runProgram(["keep-context", "--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("resume");
    expect(out.stdout).toMatch(/one-shot|next iteration/i);
  });

  it("missing PR argument on a command that requires one is rejected", () => {
    const out = runProgram(["confirm"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr + out.errorMessage).toMatch(/missing required argument|<pr>/i);
  });
});

describe("claudeSessionPath", () => {
  it("encodes `:`, `/`, `\\` as `-` in the project dir component", () => {
    const p = claudeSessionPath("C:/Users/me/repos/proj", "abc-123");
    // Path separator is platform-dependent; assert on the encoded dir name + filename.
    expect(p).toMatch(/[\\/]\.claude[\\/]projects[\\/]C--Users-me-repos-proj[\\/]abc-123\.jsonl$/);
  });
});

describe("findResumableIteration", () => {
  const claudeIter = (sessionId: string, cwd: string, sha = "deadbeef") => ({
    sessionId,
    agentRuntime: "claude",
    cwd,
    sha,
  });

  it("returns the latest iteration when its session exists on disk", async () => {
    const iters = [claudeIter("old", "C:/x"), claudeIter("new", "C:/x")];
    const found = await findResumableIteration(iters, undefined, async () => true);
    expect(found?.iter.sessionId).toBe("new");
    expect(found?.index).toBe(1);
  });

  it("falls back to a prior iteration when the latest JSONL is missing", async () => {
    const iters = [claudeIter("good", "C:/x"), claudeIter("broken", "C:/x")];
    const exists = async (p: string) => p.includes("good");
    const found = await findResumableIteration(iters, undefined, exists);
    expect(found?.iter.sessionId).toBe("good");
    expect(found?.index).toBe(0);
  });

  it("returns null when no iteration has an on-disk session", async () => {
    const iters = [claudeIter("a", "C:/x"), claudeIter("b", "C:/x")];
    const found = await findResumableIteration(iters, undefined, async () => false);
    expect(found).toBeNull();
  });

  it("accepts non-claude runtimes without checking disk (we can't validate)", async () => {
    const iters = [{ sessionId: "copilot-1", agentRuntime: "copilot", cwd: "C:/x" }];
    let called = false;
    const found = await findResumableIteration(iters, undefined, async () => {
      called = true;
      return false;
    });
    expect(called).toBe(false);
    expect(found?.iter.sessionId).toBe("copilot-1");
  });

  it("uses fallbackCwd when an iteration has no recorded cwd", async () => {
    const iters = [
      { sessionId: "legacy", agentRuntime: "claude", sha: "abc" }, // no cwd
    ];
    let probed = "";
    const found = await findResumableIteration(iters, "C:/fallback", async (p) => {
      probed = p;
      return true;
    });
    expect(probed).toMatch(/C--fallback/);
    expect(found?.iter.sessionId).toBe("legacy");
  });
});
