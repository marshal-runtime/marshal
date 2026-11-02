import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProgram } from "../src/cli.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "macp-wait-"));
  process.env.MARSHAL_ACP_HOME = tmp;
  await fs.mkdir(path.join(tmp, "sessions"), { recursive: true });
});

afterEach(async () => {
  delete process.env.MARSHAL_ACP_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

function runProgramHelp(argv: string[]): { stdout: string; exitCode: number | undefined } {
  const program = buildProgram();
  let exitCode: number | undefined;
  let stdout = "";
  program.exitOverride((err) => {
    exitCode = err.exitCode;
    throw err;
  });
  program.configureOutput({
    writeOut: (s: string) => {
      stdout += s;
    },
    writeErr: () => {},
  });
  for (const sub of program.commands) {
    sub.exitOverride((err) => {
      exitCode = err.exitCode;
      throw err;
    });
    sub.configureOutput({
      writeOut: (s: string) => {
        stdout += s;
      },
      writeErr: () => {},
    });
  }
  try {
    program.parse(["node", "cli.ts", ...argv]);
  } catch {
    // swallow exit-via-throw
  }
  return { stdout, exitCode };
}

describe("status / wait commands — help surface", () => {
  it("top-level --help lists `status` and `wait`", () => {
    const out = runProgramHelp(["--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("status");
    expect(out.stdout).toContain("wait");
  });

  it("`wait --help` documents --timeout and --poll-interval", () => {
    const out = runProgramHelp(["wait", "--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("--timeout");
    expect(out.stdout).toContain("--poll-interval");
  });

  it("`status --help` exits 0", () => {
    const out = runProgramHelp(["status", "--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.toLowerCase()).toMatch(/in-flight|recent|running/);
  });
});

describe("--detach + --resume filename (Bug 1 regression pin)", () => {
  it("sessionFilePath resolves a basename relative to sessionsDir() so --resume writes to the existing file", async () => {
    // The fix in cmdPrompt --detach is:
    //   filePath = opts.resume
    //     ? sessionFilePath(opts.resume)            // <- this branch
    //     : path.join(sessionsDir(), buildSessionFilename(...));
    // Pin the contract that sessionFilePath returns the resolved path of
    // the EXISTING file when given a basename.
    const { sessionFilePath } = await import("../src/paths.ts");
    const existing = "2026-05-14T08-00-00-000Z-original.md";
    expect(sessionFilePath(existing)).toBe(path.join(tmp, "sessions", existing));
  });
});
