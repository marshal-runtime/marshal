// Marshal-owned module.
import { describe, it, expect } from "vitest";

import { spawnConfigFor } from "../src/runtimes/index.ts";

describe("runtimes", () => {
  it("claude adapter spawns the resolved claude-agent-acp entry directly, blocks GH_TOKEN", () => {
    const cfg = spawnConfigFor("claude", { cwd: "/tmp" });
    expect(cfg.cmd).toBe(process.execPath);
    expect(cfg.args).toHaveLength(1);
    expect(cfg.args[0]).toMatch(/claude-agent-acp[\\/]dist[\\/]index\.js$/);
    expect(cfg.env.GH_TOKEN).toBe("");
    expect(cfg.cwd).toBe("/tmp");
  });

  it("copilot adapter spawns copilot --acp with deny patterns, blocks GH_TOKEN", () => {
    const cfg = spawnConfigFor("copilot", { cwd: "/tmp" });
    expect(cfg.cmd).toBe(process.platform === "win32" ? "copilot.exe" : "copilot");
    expect(cfg.args[0]).toBe("--acp");
    expect(cfg.args).toContain("--allow-all-tools");
    expect(cfg.args).toContain("shell(gh pr comment:*)");
    expect(cfg.args).toContain("shell(curl:*api.github.com*)");
    // Each deny pattern preceded by a --deny-tool flag
    const denyCount = cfg.args.filter((a) => a === "--deny-tool").length;
    expect(denyCount).toBeGreaterThanOrEqual(10);
    expect(cfg.env.GH_TOKEN).toBe("");
    expect(cfg.cwd).toBe("/tmp");
  });
});
