import type { Skill, WorkspaceDirEntry } from "@common/marshal-ipc-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs } from "@/test-utils";

import { ExtensionApiBuilder } from "./extension-api-factory";

describe("ExtensionApiBuilder", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the same API instance for the same extension id", () => {
    const builder = new ExtensionApiBuilder();

    const first = builder.build("ext-a");
    const second = builder.build("ext-a");

    expect(second).toBe(first);
    expect(first.extensionId).toBe("ext-a");
  });

  it("returns different API instances for different extension ids", () => {
    const builder = new ExtensionApiBuilder();

    const first = builder.build("ext-a");
    const second = builder.build("ext-b");

    expect(second).not.toBe(first);
    expect(first.extensionId).toBe("ext-a");
    expect(second.extensionId).toBe("ext-b");
  });

  it("evicts a cached API instance", () => {
    const builder = new ExtensionApiBuilder();

    const first = builder.build("ext-a");
    builder.evict("ext-a");
    const second = builder.build("ext-a");

    expect(second).not.toBe(first);
  });

  it("returns a frozen API surface", () => {
    const builder = new ExtensionApiBuilder();
    const api = builder.build("ext-a");

    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.chat)).toBe(true);
    expect(Object.isFrozen(api.workspace)).toBe(true);
    expect(Object.isFrozen(api.skills)).toBe(true);
  });

  it("routes chat.send through copilotAPI.send", async () => {
    const builder = new ExtensionApiBuilder();
    const api = builder.build("ext-a");

    const result = await api.chat.send("hello", "session-1");

    expect(window.copilotAPI.send).toHaveBeenCalledWith("hello", "session-1");
    expect(result).toEqual({ success: true });
  });

  it("returns fallback error when copilotAPI is unavailable", async () => {
    Object.defineProperty(window, "copilotAPI", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const builder = new ExtensionApiBuilder();
    const api = builder.build("ext-a");

    await expect(api.chat.send("hello")).resolves.toEqual({
      success: false,
      error: "copilotAPI unavailable",
    });
  });

  it("maps workspace.readFile responses to string or null", async () => {
    const builder = new ExtensionApiBuilder();
    const api = builder.build("ext-a");

    vi.mocked(window.workspaceAPI.readFile).mockResolvedValueOnce({
      success: true,
      type: "text",
      content: "abc",
    });
    await expect(api.workspace.readFile("/a.txt")).resolves.toBe("abc");

    vi.mocked(window.workspaceAPI.readFile).mockResolvedValueOnce({
      success: true,
      type: "text",
      content: undefined,
    });
    await expect(api.workspace.readFile("/b.txt")).resolves.toBeNull();

    vi.mocked(window.workspaceAPI.readFile).mockResolvedValueOnce({
      success: false,
      error: "boom",
    });
    await expect(api.workspace.readFile("/c.txt")).resolves.toBeNull();
  });

  it("returns null from workspace.readFile when workspaceAPI is unavailable", async () => {
    Object.defineProperty(window, "workspaceAPI", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const builder = new ExtensionApiBuilder();
    const api = builder.build("ext-a");

    await expect(api.workspace.readFile("/a.txt")).resolves.toBeNull();
  });

  it("routes workspace.writeFile and listDir, including fallbacks", async () => {
    const entries: WorkspaceDirEntry[] = [{ name: "docs", type: "directory" }];
    const builder = new ExtensionApiBuilder();
    const api = builder.build("ext-a");

    vi.mocked(window.workspaceAPI.writeFile).mockResolvedValueOnce({ success: true });
    await expect(api.workspace.writeFile("/a.txt", "hello")).resolves.toEqual({ success: true });
    expect(window.workspaceAPI.writeFile).toHaveBeenCalledWith("/a.txt", "hello");

    vi.mocked(window.workspaceAPI.listDir).mockResolvedValueOnce({ success: true, entries });
    await expect(api.workspace.listDir("/workspace")).resolves.toEqual(entries);

    vi.mocked(window.workspaceAPI.listDir).mockResolvedValueOnce({ success: false, error: "boom" });
    await expect(api.workspace.listDir("/missing")).resolves.toEqual([]);

    Object.defineProperty(window, "workspaceAPI", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    await expect(api.workspace.writeFile("/x.txt", "x")).resolves.toEqual({
      success: false,
      error: "workspaceAPI unavailable",
    });
    await expect(api.workspace.listDir("/workspace")).resolves.toEqual([]);
  });

  it("routes skills.list and returns [] for failed/unavailable calls", async () => {
    const skills: Skill[] = [
      {
        id: "skill-1",
        name: "Skill 1",
        description: "desc",
        instructions: "test instructions",
        enabled: true,
        createdAt: new Date().toISOString(),
        scope: "local",
      },
    ];
    const builder = new ExtensionApiBuilder();
    const api = builder.build("ext-a");

    vi.mocked(window.skillsAPI.list).mockResolvedValueOnce({ success: true, skills });
    await expect(api.skills.list()).resolves.toEqual(skills);

    vi.mocked(window.skillsAPI.list).mockResolvedValueOnce({ success: false, error: "boom" });
    await expect(api.skills.list()).resolves.toEqual([]);

    Object.defineProperty(window, "skillsAPI", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    await expect(api.skills.list()).resolves.toEqual([]);
  });
});
