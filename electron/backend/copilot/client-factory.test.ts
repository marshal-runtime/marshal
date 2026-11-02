import os from "node:os";

import { CopilotClient } from "@github/copilot-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = await vi.hoisted(async () => await import("../../test-helpers/session-test-mocks"));
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("../../cli-path", m.cliPathFactory);

describe("createRealClientFactory env cleanup", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
  });

  // Tier B of the Electron-fuses hardening. Parent NODE_OPTIONS must NOT propagate to the Copilot
  // CLI subprocess — the bundled Node it spawns is not fuse-protected, so a
  // --require injection from the parent env would land inside it. Same for
  // ELECTRON_RUN_AS_NODE (no-op post-fuse-flip but kept tidy) and stale GH
  // tokens.
  it("strips unsafe parent variables and replaces the inherited npm cache", async () => {
    process.env.NODE_OPTIONS = "--require /tmp/payload.js";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.GH_TOKEN = "ghp_attacker";
    process.env.GITHUB_TOKEN = "ghp_attacker_2";
    process.env.ELECTRON_NO_ASAR = "1";
    process.env.NPM_CONFIG_CACHE = String.raw`Q:\.tools\.npm`;
    process.env.LOCALAPPDATA = String.raw`C:\Users\test\AppData\Local`;
    process.env.SHOULD_PASS_THROUGH = "ok";

    const CopilotClientMock = vi.mocked(CopilotClient);
    CopilotClientMock.mockImplementation(
      function MockCopilotClient(this: { start: () => Promise<void> }) {
        this.start = () => Promise.resolve();
      },
    );

    const { createRealClientFactory } = await import("./client-factory");
    await createRealClientFactory()("/workspace");

    expect(CopilotClientMock).toHaveBeenCalledTimes(1);
    const env = CopilotClientMock.mock.calls[0]?.[0]?.env ?? {};
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ELECTRON_NO_ASAR).toBeUndefined();
    expect(env.NPM_CONFIG_CACHE).toBe(
      process.platform === "win32" ? String.raw`C:\Users\test\AppData\Local\npm-cache` : undefined,
    );
    expect(env.SHOULD_PASS_THROUGH).toBe("ok");
  });

  it("passes the bundled CLI and workspace through the SDK 1.x connection API", async () => {
    const CopilotClientMock = vi.mocked(CopilotClient);
    CopilotClientMock.mockImplementation(
      function MockCopilotClient(this: { start: () => Promise<void> }) {
        this.start = () => Promise.resolve();
      },
    );

    const { createRealClientFactory } = await import("./client-factory");
    await createRealClientFactory()(String.raw`C:\workspace`);

    expect(CopilotClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: String.raw`C:\workspace`,
        connection: {
          kind: "stdio",
          path: "/mock/copilot",
        },
      }),
    );
  });

  it("sets conservative inherited worker hints without overriding explicit values", async () => {
    process.env.CARGO_BUILD_JOBS = "2";
    const CopilotClientMock = vi.mocked(CopilotClient);
    CopilotClientMock.mockImplementation(
      function MockCopilotClient(this: { start: () => Promise<void> }) {
        this.start = () => Promise.resolve();
      },
    );

    const { createRealClientFactory } = await import("./client-factory");
    await createRealClientFactory()("/workspace");

    const env = CopilotClientMock.mock.calls[0]?.[0]?.env ?? {};
    expect(env.CARGO_BUILD_JOBS).toBe("2");
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe("4");
    expect(env.CTEST_PARALLEL_LEVEL).toBe("4");
    expect(env.MAKEFLAGS).toBe("-j4");
    expect(env.NINJAFLAGS).toBe("-j4");
  });

  it("keeps the owned Copilot CLI process at normal priority", async () => {
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    try {
      const CopilotClientMock = vi.mocked(CopilotClient);
      CopilotClientMock.mockImplementation(function MockCopilotClient(this: CopilotClient) {
        Object.assign(this, {
          cliProcess: { pid: 4242 },
          start: () => Promise.resolve(),
        });
      });

      const { createRealClientFactory } = await import("./client-factory");
      await createRealClientFactory()("/workspace");

      expect(setPriority).not.toHaveBeenCalled();
    } finally {
      setPriority.mockRestore();
    }
  });

  it("sanitizes GIT_* env vars to block gitconfig-based subprocess execution", async () => {
    process.env.GIT_PAGER = "malicious-pager";
    process.env.GIT_EXTERNAL_DIFF = "evil-diff-tool";
    process.env.GIT_EDITOR = "evil-editor";
    process.env.GIT_ASKPASS = "evil-askpass";
    process.env.GIT_TERMINAL_PROMPT = "1";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.pager";
    process.env.GIT_CONFIG_VALUE_0 = "touch /tmp/pwned";

    const CopilotClientMock = vi.mocked(CopilotClient);
    CopilotClientMock.mockImplementation(
      function MockCopilotClient(this: { start: () => Promise<void> }) {
        this.start = () => Promise.resolve();
      },
    );

    const { createRealClientFactory } = await import("./client-factory");
    const { GIT_SAFE_ALIAS_SUBCOMMANDS } = await import("../../permission-policy");
    await createRealClientFactory()("/workspace");

    const env = CopilotClientMock.mock.calls[0]?.[0]?.env ?? {};
    expect(env.GIT_PAGER).toBe("");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(env.GIT_EDITOR).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    // Attacker's GIT_CONFIG payload is stripped and replaced by our trusted alias overrides.
    // GIT_CONFIG_COUNT reflects our injection, not the attacker's "1".
    expect(env.GIT_CONFIG_COUNT).toBe(String(GIT_SAFE_ALIAS_SUBCOMMANDS.length));
    // KEY_0/VALUE_0 are our first alias override, not the attacker's core.pager payload.
    expect(env.GIT_CONFIG_KEY_0).toBe(`alias.${GIT_SAFE_ALIAS_SUBCOMMANDS[0]}`);
    expect(env.GIT_CONFIG_VALUE_0).toBe(GIT_SAFE_ALIAS_SUBCOMMANDS[0]);
    // Verify the attacker's core.pager payload is not present anywhere in the injected pairs.
    const injectedValues = Array.from(
      { length: GIT_SAFE_ALIAS_SUBCOMMANDS.length },
      (_, i) => env[`GIT_CONFIG_VALUE_${i}`],
    );
    expect(injectedValues).not.toContain("touch /tmp/pwned");
  });

  it("injects GIT_CONFIG alias overrides to neutralize gitconfig alias hijacking", async () => {
    // Simulate attacker pre-loading a hostile alias via parent env
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "alias.blame";
    process.env.GIT_CONFIG_VALUE_0 = "!evil-payload";

    const CopilotClientMock = vi.mocked(CopilotClient);
    CopilotClientMock.mockImplementation(
      function MockCopilotClient(this: { start: () => Promise<void> }) {
        this.start = () => Promise.resolve();
      },
    );

    const { createRealClientFactory } = await import("./client-factory");
    const { GIT_SAFE_ALIAS_SUBCOMMANDS } = await import("../../permission-policy");
    await createRealClientFactory()("/workspace");

    const env = CopilotClientMock.mock.calls[0]?.[0]?.env ?? {};
    const count = Number(env.GIT_CONFIG_COUNT);

    // Count must equal our alias list length
    expect(count).toBe(GIT_SAFE_ALIAS_SUBCOMMANDS.length);

    // Build key→value map from the injected GIT_CONFIG pairs
    const injected: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      const k = env[`GIT_CONFIG_KEY_${i}`];
      const v = env[`GIT_CONFIG_VALUE_${i}`];
      if (k !== undefined && v !== undefined) injected[k] = v;
    }

    // Every auto-approved subcommand must be self-aliased
    for (const sub of GIT_SAFE_ALIAS_SUBCOMMANDS) {
      expect(injected[`alias.${sub}`]).toBe(sub);
    }
  });

  it("GIT_SAFE_ALIAS_SUBCOMMANDS entries each have an auto-approved form in isReadOnlyCommand", async () => {
    const { GIT_SAFE_ALIAS_SUBCOMMANDS, isReadOnlyCommand } =
      await import("../../permission-policy");

    // Maps each alias-protected subcommand to one canonical auto-approved command form.
    // If a subcommand is added to GIT_SAFE_ALIAS_SUBCOMMANDS, add it here too —
    // the test fails with "missing canonical form for X" until you do.
    const canonicalForms: Record<string, string> = {
      blame: "git blame",
      branch: "git branch",
      config: "git config --list",
      describe: "git describe",
      log: "git log",
      reflog: "git reflog",
      remote: "git remote",
      "rev-parse": "git rev-parse",
      shortlog: "git shortlog",
      stash: "git stash list",
      submodule: "git submodule status",
      tag: "git tag",
      worktree: "git worktree list",
    };

    for (const sub of GIT_SAFE_ALIAS_SUBCOMMANDS) {
      const form = canonicalForms[sub];
      expect(form, `missing canonical form for alias-protected subcommand "${sub}"`).toBeDefined();
      expect(isReadOnlyCommand(form), `"${form}" should be auto-approved`).toBe(true);
    }
  });
});
