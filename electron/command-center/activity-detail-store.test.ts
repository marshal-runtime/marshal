import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SessionMetadata } from "../../common/marshal-ipc-contract";
import { writeEncryptedFileSync } from "../safe-storage-file";
import { CommandCenterActivityDetailStore } from "./activity-detail-store";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

function session(id: string, parentSessionId?: string): SessionMetadata {
  return {
    id,
    name: id,
    createdAt: "",
    updatedAt: "",
    hasUnread: false,
    isActive: false,
    ...(parentSessionId ? { parentSessionId, source: "subagent" } : {}),
  };
}

function createGitRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(path.join(tmpdir(), "cc-activity-repo-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo, windowsHide: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(repo, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], {
    cwd: repo,
    stdio: "ignore",
    windowsHide: true,
  });
  return repo;
}

function readPersisted(filePath: string): {
  sessions: Record<string, { fileBaselines?: Record<string, unknown>; fileChanges?: unknown[] }>;
} {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function storePath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "cc-activity-")), "details.json.enc");
}

function patchFor(kind: "Add" | "Update", filePath: string, lines: string[]): string {
  return ["*** Begin Patch", `*** ${kind} File: ${filePath}`, "@@", ...lines, "*** End Patch"].join(
    "\n",
  );
}

describe("CommandCenterActivityDetailStore", () => {
  it("persists apply_patch file changes with line counts and aggregates descendant sessions", async () => {
    const filePath = path.join(
      mkdtempSync(path.join(tmpdir(), "cc-activity-")),
      "details.json.enc",
    );
    const store = new CommandCenterActivityDetailStore(filePath);

    store.recordToolResult({
      sessionId: "child",
      toolCallId: "tool-1",
      toolName: "apply_patch",
      args: {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/app.ts",
          "@@",
          "-old line",
          "+new line",
          "+another line",
          "*** End Patch",
        ].join("\n"),
      },
      result: { success: true },
    });
    await store.flush();

    const reloaded = new CommandCenterActivityDetailStore(filePath);
    reloaded.reload();
    const activity = reloaded.getSessionActivity("root", [
      session("root"),
      session("child", "root"),
    ]);

    expect(activity.sessionIds).toEqual(["root", "child"]);
    expect(activity.fileChanges).toHaveLength(1);
    expect(activity.fileChanges[0]).toMatchObject({
      sessionId: "child",
      path: "src/app.ts",
      additions: 2,
      deletions: 1,
    });
    expect(activity.fileChanges[0]?.diff).toContain("*** Begin Patch");
  });

  it("creates the activity detail directory before saving", async () => {
    const filePath = path.join(
      mkdtempSync(path.join(tmpdir(), "cc-activity-")),
      "missing",
      "nested",
      "details.json.enc",
    );
    const store = new CommandCenterActivityDetailStore(filePath);

    store.recordToolResult({
      sessionId: "root",
      toolCallId: "tool-dir",
      toolName: "apply_patch",
      args: {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/app.ts",
          "@@",
          "+new line",
          "*** End Patch",
        ].join("\n"),
      },
      result: { success: true },
    });
    await store.flush();

    const reloaded = new CommandCenterActivityDetailStore(filePath);
    reloaded.reload();
    expect(reloaded.getSessionActivity("root", [session("root")]).fileChanges).toHaveLength(1);
  });

  it("batches writes off the tool path and keeps unsaved changes across reload", async () => {
    const filePath = storePath();
    const store = new CommandCenterActivityDetailStore(filePath);
    store.recordToolResult({
      sessionId: "root",
      toolCallId: "tool-batched",
      toolName: "apply_patch",
      args: { patch: patchFor("Update", "src/app.ts", ["+new line"]) },
      result: { success: true },
    });

    expect(existsSync(filePath)).toBe(false);
    store.reload();
    expect(store.getSessionActivity("root", [session("root")]).fileChanges).toHaveLength(1);

    await store.flush();
    expect(existsSync(filePath)).toBe(true);
  });

  it("keeps only the 300 most recently active sessions", async () => {
    const filePath = storePath();
    const now = Date.now();
    const sessions: Record<string, unknown> = {};
    for (let index = 0; index < 301; index++) {
      sessions[`s${index}`] = { fileChanges: [], sources: [], lastActivityAt: now - index * 1000 };
    }
    writeFileSync(filePath, JSON.stringify({ sessions }));

    const store = new CommandCenterActivityDetailStore(filePath);
    store.reload();
    await store.flush();

    const persisted = readPersisted(filePath);
    expect(Object.keys(persisted.sessions)).toHaveLength(300);
    expect(persisted.sessions.s0).toBeDefined();
    expect(persisted.sessions.s300).toBeUndefined();
  });

  it("drops file baselines of quiet sessions but keeps their recorded changes", async () => {
    const filePath = storePath();
    const now = Date.now();
    const quietAt = now - 7 * 60 * 60 * 1000;
    const baseline = (sessionId: string, updatedAt: number) => ({
      sessionId,
      path: "a.ts",
      label: "a.ts",
      toolName: "Edit",
      exists: true,
      content: "x",
      updatedAt,
    });
    const change = {
      id: "c1",
      sessionId: "quiet",
      path: "a.ts",
      label: "a.ts",
      toolName: "Edit",
      additions: 1,
      deletions: 0,
      updatedAt: quietAt,
    };
    writeFileSync(
      filePath,
      JSON.stringify({
        sessions: {
          active: { fileChanges: [], sources: [], fileBaselines: { a: baseline("active", now) } },
          quiet: {
            fileChanges: [change],
            sources: [],
            fileBaselines: { a: baseline("quiet", quietAt) },
          },
        },
      }),
    );

    const store = new CommandCenterActivityDetailStore(filePath);
    store.reload();
    await store.flush();

    const persisted = readPersisted(filePath);
    expect(persisted.sessions.active?.fileBaselines).toHaveProperty("a");
    expect(persisted.sessions.quiet?.fileBaselines).toEqual({});
    expect(persisted.sessions.quiet?.fileChanges).toHaveLength(1);
  });

  it("does not hydrate apply_patch file changes before the tool completes", () => {
    const filePath = path.join(
      mkdtempSync(path.join(tmpdir(), "cc-activity-")),
      "details.json.enc",
    );
    const store = new CommandCenterActivityDetailStore(filePath);

    store.recordToolStart({
      sessionId: "root",
      toolCallId: "tool-start-only",
      toolName: "apply_patch",
      args: {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/app.ts",
          "@@",
          "+new line",
          "*** End Patch",
        ].join("\n"),
      },
    });

    expect(store.getSessionActivity("root", [session("root")]).fileChanges).toHaveLength(0);
  });

  it("truncates very large diffs before keeping them in activity details", () => {
    const filePath = path.join(
      mkdtempSync(path.join(tmpdir(), "cc-activity-")),
      "details.json.enc",
    );
    const store = new CommandCenterActivityDetailStore(filePath);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/huge.ts",
      "@@",
      `+${"x".repeat(80 * 1024)}`,
      "*** End Patch",
    ].join("\n");

    store.recordToolResult({
      sessionId: "root",
      toolCallId: "tool-huge",
      toolName: "apply_patch",
      args: { patch },
      result: { success: true },
    });

    const activity = store.getSessionActivity("root", [session("root")]);
    expect(activity.fileChanges[0]?.diff).toContain("...[truncated]");
    expect(activity.fileChanges[0]?.diffTruncated).toBe(true);
    expect(Buffer.byteLength(activity.fileChanges[0]?.diff ?? "", "utf8")).toBeLessThanOrEqual(
      64 * 1024,
    );
  });

  it("captures baseline diffs with focused hunk context", () => {
    const original = Array.from({ length: 80 }, (_, index) => {
      return `stable-${String(index + 1).padStart(3, "0")}`;
    });
    const updated = [...original];
    updated[24] = "changed-025";
    updated[69] = "changed-070";
    const repo = createGitRepo({ "app.ts": `${original.join("\n")}\n` });
    const target = path.join(repo, "app.ts");
    const store = new CommandCenterActivityDetailStore(storePath());

    store.recordToolStart({
      sessionId: "root",
      toolCallId: "edit-scoped",
      toolName: "edit_file",
      args: { filePath: target },
    });
    writeFileSync(target, `${updated.join("\n")}\n`);
    store.recordToolResult({
      sessionId: "root",
      toolCallId: "edit-scoped",
      toolName: "edit_file",
      args: { filePath: target },
      result: { success: true },
    });

    const change = store.getSessionActivity("root", [session("root")]).fileChanges[0];
    expect(change?.diffContextLines).toBe(3);
    expect(change?.diff).toContain("+changed-025");
    expect(change?.diff).toContain("+changed-070");
    expect(change?.diff).not.toContain(" stable-001");
    expect(change?.diff).not.toContain(" stable-040");
  });

  it("keeps targeted source-too-large file changes with explicit unavailable metadata", () => {
    const repo = createGitRepo({});
    const target = path.join(repo, "huge.ts");
    const hugeContent = `${"x".repeat(512 * 1024 + 1)}\n`;
    writeFileSync(target, hugeContent);
    const store = new CommandCenterActivityDetailStore(storePath());

    store.recordToolStart({
      sessionId: "root",
      toolCallId: "edit-huge-source",
      toolName: "edit_file",
      args: { filePath: target },
    });
    writeFileSync(target, `${hugeContent}changed\n`);
    store.recordToolResult({
      sessionId: "root",
      toolCallId: "edit-huge-source",
      toolName: "edit_file",
      args: { filePath: target },
      result: { success: true },
    });

    const change = store.getSessionActivity("root", [session("root")]).fileChanges[0];
    expect(change).toMatchObject({
      additions: 0,
      deletions: 0,
      diffUnavailableReason: "source-too-large",
    });
    expect(change?.diff).toBeUndefined();
  });

  it("tracks pull request and email sources and ignores unrecognized tools", () => {
    const store = new CommandCenterActivityDetailStore(storePath());

    store.recordToolStart({
      sessionId: "root",
      toolCallId: "query-1",
      toolName: "execute_query",
      serverName: "analytics-mcp",
      args: { query: "SELECT 1" },
    });
    store.recordToolStart({
      sessionId: "root",
      toolCallId: "pr-1",
      toolName: "get_pull_request",
      args: { url: "https://git.example.com/org/project/_git/repo/pullrequest/42" },
    });
    store.recordToolStart({
      sessionId: "root",
      toolCallId: "email-1",
      toolName: "send_email",
      args: {},
    });

    const activity = store.getSessionActivity("root", [session("root")]);

    expect(activity.sources.map((source) => source.kind).sort()).toEqual(["email", "pr"]);
    expect(activity.sources.some((source) => source.url?.includes("pullrequest/42"))).toBe(true);
  });

  it("tracks file changes from JSON-string tool args and replacement counts", () => {
    const filePath = path.join(
      mkdtempSync(path.join(tmpdir(), "cc-activity-")),
      "details.json.enc",
    );
    const store = new CommandCenterActivityDetailStore(filePath);

    store.recordToolResult({
      sessionId: "root",
      toolCallId: "edit-1",
      toolName: "edit_file",
      args: JSON.stringify({
        filePath: "C:/repo/app.ts",
        old_str: "one\ntwo",
        new_str: "one\ntwo\nthree",
      }),
      result: { success: true },
    });

    const activity = store.getSessionActivity("root", [session("root")]);
    expect(activity.fileChanges[0]?.path.replace(/\\/g, "/")).toBe("C:/repo/app.ts");
    expect(activity.fileChanges[0]).toMatchObject({ additions: 2, deletions: 1 });
  });

  it("enriches sources from tool results when links arrive after execution", () => {
    const store = new CommandCenterActivityDetailStore(storePath());

    store.recordToolStart({
      sessionId: "root",
      toolCallId: "pr-2",
      toolName: "get_pull_request",
      args: { id: 211959 },
    });
    store.recordToolResult({
      sessionId: "root",
      toolCallId: "pr-2",
      toolName: "get_pull_request",
      args: { id: 211959 },
      result: { webUrl: "https://git.example.com/org/proj/_git/repo/pullrequest/211959" },
    });
    store.recordToolResult({
      sessionId: "root",
      toolCallId: "pr-duplicate",
      toolName: "repo_get_pull_request",
      args: { pullRequestId: 211959 },
      result: { webUrl: "https://git.example.com/org/proj/_git/repo/pullrequest/211959" },
    });

    const activity = store.getSessionActivity("root", [session("root")]);
    const prSources = activity.sources.filter((source) => source.kind === "pr");
    expect(prSources).toHaveLength(1);
    expect(prSources[0]).toMatchObject({
      id: "root:pr:211959",
      kind: "pr",
      label: "Pull request 211959",
      url: "https://git.example.com/org/proj/_git/repo/pullrequest/211959",
    });
  });

  it("reads sources persisted with removed kinds as other instead of dropping them", () => {
    const filePath = storePath();
    const legacySource = (kind: string, label: string) => ({
      id: `root:${kind}`,
      sessionId: "root",
      kind,
      label,
      toolName: `${kind}_tool`,
      updatedAt: 1,
    });
    writeEncryptedFileSync(
      filePath,
      JSON.stringify({
        sessions: {
          root: {
            fileChanges: [],
            sources: [
              legacySource("kusto", "Legacy query"),
              legacySource("ado", "Legacy work item 12"),
              legacySource("m365", "Legacy mail"),
              legacySource("pr", "Pull request 7"),
            ],
          },
        },
      }),
    );
    const store = new CommandCenterActivityDetailStore(filePath);
    store.reload();

    const sources = store.getSessionActivity("root", [session("root")]).sources;
    expect(
      sources.map((source) => [source.label, source.kind]).sort(([a], [b]) => a.localeCompare(b)),
    ).toEqual([
      ["Legacy mail", "other"],
      ["Legacy query", "other"],
      ["Legacy work item 12", "other"],
      ["Pull request 7", "pr"],
    ]);
  });

  it("hydrates baseline diffs and line counts for changed tracked files", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "cc-activity-repo-"));
    const detailsPath = path.join(
      mkdtempSync(path.join(tmpdir(), "cc-activity-")),
      "details.json.enc",
    );
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore", windowsHide: true });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
      windowsHide: true,
    });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo, windowsHide: true });
    const target = path.join(repo, "app.ts");
    writeFileSync(target, "old\nkeep\n");
    execFileSync("git", ["add", "app.ts"], { cwd: repo, windowsHide: true });
    execFileSync("git", ["commit", "-m", "initial"], {
      cwd: repo,
      stdio: "ignore",
      windowsHide: true,
    });

    const store = new CommandCenterActivityDetailStore(detailsPath);
    store.recordToolStart({
      sessionId: "root",
      toolCallId: "edit-baseline",
      toolName: "edit_file",
      args: { filePath: JSON.stringify([target]) },
    });
    writeFileSync(target, "new\nkeep\nadded\n");
    store.recordToolResult({
      sessionId: "root",
      toolCallId: "edit-baseline",
      toolName: "edit_file",
      args: { filePath: JSON.stringify([target]) },
      result: { success: true },
    });

    const activity = store.getSessionActivity("root", [session("root")]);
    expect(activity.fileChanges[0]?.path).toBe(path.normalize(target));
    expect(activity.fileChanges[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(activity.fileChanges[0]?.diff).toContain("-old");
    expect(activity.fileChanges[0]?.diff).toContain("+new");
    expect(activity.fileChanges[0]?.diff).toContain("+added");
  });

  it("serves the recorded diff without re-reading files at query time", () => {
    const repo = createGitRepo({ "app.ts": "before\n" });
    const target = path.join(repo, "app.ts");
    const store = new CommandCenterActivityDetailStore(storePath());

    store.recordToolStart({
      sessionId: "root",
      toolCallId: "edit-1",
      toolName: "edit_file",
      args: { filePath: target },
    });
    writeFileSync(target, "after\n");
    store.recordToolResult({
      sessionId: "root",
      toolCallId: "edit-1",
      toolName: "edit_file",
      args: { filePath: target },
      result: { success: true },
    });
    const recorded = store.getSessionActivity("root", [session("root")]).fileChanges[0];

    writeFileSync(target, "external mutation that was not a tracked action\n");
    const queried = store.getSessionActivity("root", [session("root")]).fileChanges[0];

    expect(queried).toEqual(recorded);
  });

  it("collapses repeated apply_patch edits to one final diff for an existing file", () => {
    const repo = createGitRepo({ "app.ts": "old\nkeep\n" });
    const target = path.join(repo, "app.ts");
    const store = new CommandCenterActivityDetailStore(storePath());
    const patchOne = patchFor("Update", "app.ts", ["-old", "+new"]);
    const patchTwo = patchFor("Update", "app.ts", [" keep", "+added"]);
    let now = 1000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++now);

    try {
      store.recordToolStart({
        sessionId: "root",
        toolCallId: "patch-1",
        toolName: "apply_patch",
        args: { cwd: repo, patch: patchOne },
      });
      writeFileSync(target, "new\nkeep\n");
      store.recordToolResult({
        sessionId: "root",
        toolCallId: "patch-1",
        toolName: "apply_patch",
        args: { cwd: repo, patch: patchOne },
        result: { success: true },
      });
      store.recordToolStart({
        sessionId: "root",
        toolCallId: "patch-2",
        toolName: "apply_patch",
        args: { cwd: repo, patch: patchTwo },
      });
      writeFileSync(target, "new\nkeep\nadded\n");
      store.recordToolResult({
        sessionId: "root",
        toolCallId: "patch-2",
        toolName: "apply_patch",
        args: { cwd: repo, patch: patchTwo },
        result: { success: true },
      });
    } finally {
      nowSpy.mockRestore();
    }

    const activity = store.getSessionActivity("root", [session("root")]);
    expect(activity.fileChanges).toHaveLength(1);
    expect(activity.fileChanges[0]?.path).toBe(path.normalize(target));
    expect(activity.fileChanges[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(activity.fileChanges[0]?.diff).toContain("-old");
    expect(activity.fileChanges[0]?.diff).toContain("+new");
    expect(activity.fileChanges[0]?.diff).toContain("+added");
  });

  it("collapses creation followed by modification into one added-file diff", () => {
    const repo = createGitRepo({});
    const target = path.join(repo, "created.ts");
    const store = new CommandCenterActivityDetailStore(storePath());
    const patchOne = patchFor("Add", "created.ts", ["+first"]);
    const patchTwo = patchFor("Update", "created.ts", [" first", "+second"]);
    let now = 2000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++now);

    try {
      store.recordToolStart({
        sessionId: "root",
        toolCallId: "patch-1",
        toolName: "apply_patch",
        args: { cwd: repo, patch: patchOne },
      });
      writeFileSync(target, "first\n");
      store.recordToolResult({
        sessionId: "root",
        toolCallId: "patch-1",
        toolName: "apply_patch",
        args: { cwd: repo, patch: patchOne },
        result: { success: true },
      });
      store.recordToolStart({
        sessionId: "root",
        toolCallId: "patch-2",
        toolName: "apply_patch",
        args: { cwd: repo, patch: patchTwo },
      });
      writeFileSync(target, "first\nsecond\n");
      store.recordToolResult({
        sessionId: "root",
        toolCallId: "patch-2",
        toolName: "apply_patch",
        args: { cwd: repo, patch: patchTwo },
        result: { success: true },
      });
    } finally {
      nowSpy.mockRestore();
    }

    const activity = store.getSessionActivity("root", [session("root")]);
    expect(activity.fileChanges).toHaveLength(1);
    expect(activity.fileChanges[0]).toMatchObject({ additions: 2, deletions: 0 });
    expect(activity.fileChanges[0]?.diff).toContain("new file mode 100644");
    expect(activity.fileChanges[0]?.diff).toContain("+first");
    expect(activity.fileChanges[0]?.diff).toContain("+second");
  });

  it("collapses only same-path apply_patch edits while preserving other files", () => {
    const repo = createGitRepo({ "app.ts": "old\nkeep\n", "other.ts": "before\n" });
    const appTarget = path.join(repo, "app.ts");
    const otherTarget = path.join(repo, "other.ts");
    const store = new CommandCenterActivityDetailStore(storePath());
    const appPatchOne = patchFor("Update", "app.ts", ["-old", "+new"]);
    const appPatchTwo = patchFor("Update", "app.ts", [" keep", "+added"]);
    const otherPatch = patchFor("Update", "other.ts", ["-before", "+after"]);
    let now = 3000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++now);

    try {
      store.recordToolStart({
        sessionId: "root",
        toolCallId: "patch-app-1",
        toolName: "apply_patch",
        args: { cwd: repo, patch: appPatchOne },
      });
      writeFileSync(appTarget, "new\nkeep\n");
      store.recordToolResult({
        sessionId: "root",
        toolCallId: "patch-app-1",
        toolName: "apply_patch",
        args: { cwd: repo, patch: appPatchOne },
        result: { success: true },
      });
      store.recordToolStart({
        sessionId: "root",
        toolCallId: "patch-app-2",
        toolName: "apply_patch",
        args: { cwd: repo, patch: appPatchTwo },
      });
      writeFileSync(appTarget, "new\nkeep\nadded\n");
      store.recordToolResult({
        sessionId: "root",
        toolCallId: "patch-app-2",
        toolName: "apply_patch",
        args: { cwd: repo, patch: appPatchTwo },
        result: { success: true },
      });
      store.recordToolStart({
        sessionId: "root",
        toolCallId: "patch-other",
        toolName: "apply_patch",
        args: { cwd: repo, patch: otherPatch },
      });
      writeFileSync(otherTarget, "after\n");
      store.recordToolResult({
        sessionId: "root",
        toolCallId: "patch-other",
        toolName: "apply_patch",
        args: { cwd: repo, patch: otherPatch },
        result: { success: true },
      });
    } finally {
      nowSpy.mockRestore();
    }

    const activity = store.getSessionActivity("root", [session("root")]);
    const appChange = activity.fileChanges.find(
      (change) => change.path === path.normalize(appTarget),
    );
    const otherChange = activity.fileChanges.find(
      (change) => change.path === path.normalize(otherTarget),
    );
    expect(activity.fileChanges).toHaveLength(2);
    expect(appChange).toMatchObject({ additions: 2, deletions: 1 });
    expect(otherChange).toMatchObject({ additions: 1, deletions: 1 });
  });
});
