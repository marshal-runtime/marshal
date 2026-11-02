import * as fs from "fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelInfo } from "../common/marshal-ipc-contract";
import type { RuntimeTarget } from "../common/runtime-accounts";
import type { IBackendProvider } from "./backend/types";
import { SessionTestAccess, testDouble } from "./testing/harness";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");

function backend(
  runtimeId: string,
  activeModels: ModelInfo[],
  listModelsForRuntime: (target: RuntimeTarget) => Promise<ModelInfo[]>,
) {
  return testDouble<IBackendProvider>({
    runtimeId,
    origin: "copilot",
    isReady: vi.fn<() => boolean>(() => true),
    destroy: vi.fn<() => Promise<void>>(async () => {}),
    dispose: vi.fn<() => Promise<void>>(async () => {}),
    setInterceptFileChooser: vi.fn<IBackendProvider["setInterceptFileChooser"]>(),
    setCustomMcpServers: vi.fn<IBackendProvider["setCustomMcpServers"]>(),
    setTimezoneProvider: vi.fn<IBackendProvider["setTimezoneProvider"]>(),
    tools: testDouble({
      listModels: async () => activeModels,
      getCachedModels: () => activeModels,
      getDefaultModel: () => activeModels[0]?.id,
    }),
    sessions: testDouble({ listModelsForRuntime }),
  });
}

describe("SessionManager.listModels across runtimes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs).readFileSync.mockReturnValue("{}");
  });

  async function fixture(
    listModelsForRuntime: (target: RuntimeTarget) => Promise<ModelInfo[]>,
    runtimeAccounts?: unknown,
    disabledModels: string[] = [],
  ) {
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager(
      "/test/workspace",
      backend("claude", [{ id: "opus", name: "Opus" }], listModelsForRuntime),
    );
    const access = new SessionTestAccess(manager);
    access.selfToolDeps = testDouble({
      settingsManager: { get: () => ({ runtimeAccounts }) },
    });
    vi.spyOn(manager["modelManager"], "isModelDisabled").mockImplementation((id) =>
      disabledModels.includes(id),
    );
    const changed = vi.fn<() => void>();
    manager.setModelsChangedListener(changed);
    return { manager, changed };
  }

  it("lists the active runtime first, then cached peer models once they have loaded", async () => {
    const { manager, changed } = await fixture(async (target) => [
      { id: "default", name: `${target.runtimeId} default` },
    ]);

    const first = await manager.listModels();
    expect(first.map((model) => [model.id, model.runtime?.label])).toEqual([
      ["opus", "Claude Agent"],
    ]);

    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    const second = await manager.listModels();
    expect(second.map((model) => [model.id, model.runtime?.label])).toEqual([
      ["opus", "Claude Agent"],
      ["codex:default", "Codex"],
      ["cursor:default", "Cursor"],
    ]);
  });

  it("leaves out a peer that fails and models a tenant policy disables", async () => {
    const { manager, changed } = await fixture(
      async (target) => {
        if (target.runtimeId === "cursor") throw new Error("not signed in");
        return [
          { id: "gpt-5.6-sol", name: "Sol" },
          { id: "gpt-5.5", name: "5.5" },
        ];
      },
      undefined,
      ["codex:gpt-5.5"],
    );

    await manager.listModels();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());

    expect((await manager.listModels()).map((model) => model.id)).toEqual([
      "opus",
      "codex:gpt-5.6-sol",
    ]);
  });

  it("refetches after the runtime models are invalidated and tells the renderer", async () => {
    const listModelsForRuntime = vi.fn<(target: RuntimeTarget) => Promise<ModelInfo[]>>(
      async () => [{ id: "m", name: "M" }],
    );
    const { manager, changed } = await fixture(listModelsForRuntime);
    await manager.listModels();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    const calls = listModelsForRuntime.mock.calls.length;
    changed.mockClear();

    manager.invalidateRuntimeModels();
    expect(changed).toHaveBeenCalledTimes(1);
    await manager.listModels();

    expect(listModelsForRuntime.mock.calls.length).toBeGreaterThan(calls);
  });
});
