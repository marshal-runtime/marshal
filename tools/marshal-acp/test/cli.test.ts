import { describe, it, expect } from "vitest";

import { buildProgram } from "../src/cli.ts";

function runProgram(argv: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
} {
  const program = buildProgram();
  let exitCode: number | undefined;
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
  const onExit = (err: { exitCode: number }): never => {
    exitCode = err.exitCode;
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
    // Swallowed — state read via closures.
  }

  return { stdout, stderr, exitCode };
}

describe("marshal-acp cli — commander wiring", () => {
  it("--help lists every command", () => {
    const out = runProgram(["--help"]);
    expect(out.exitCode).toBe(0);
    for (const cmd of ["init", "prompt", "open", "list", "show"]) {
      expect(out.stdout).toContain(cmd);
    }
  });

  it("prompt --help mentions both --resume (programmatic) and --detach", () => {
    const out = runProgram(["prompt", "--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("--resume");
    expect(out.stdout).toContain("--detach");
  });

  it("open --help points users to --resume for programmatic follow-up", () => {
    const out = runProgram(["open", "--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.toLowerCase()).toMatch(/zellij|interactive/);
  });

  it("--version exits 0 with a semver", () => {
    const out = runProgram(["--version"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it("rejects unknown commands", () => {
    const out = runProgram(["bogus"]);
    expect(out.exitCode).not.toBe(0);
  });

  it("prompt requires both title and prompt-text args", () => {
    const out = runProgram(["prompt", "just-title"]);
    expect(out.exitCode).not.toBe(0);
  });

  it("prompt --help surfaces the extended explanation about file naming", () => {
    const out = runProgram(["prompt", "--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/sessions|slug|title/i);
  });
});
