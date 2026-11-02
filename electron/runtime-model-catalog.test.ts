import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelInfo } from "../common/marshal-ipc-contract";
import type { RuntimeAccountsSettings, RuntimeTarget } from "../common/runtime-accounts";
import {
  RuntimeModelCatalog,
  activeRuntimeGroup,
  runtimeGroupLabel,
  type RuntimeModelCatalogDeps,
} from "./runtime-model-catalog";

type Fetch = (target: RuntimeTarget) => Promise<ModelInfo[]>;

function makeCatalog(options: {
  active?: string;
  accounts?: RuntimeAccountsSettings;
  fetch?: Fetch;
  disabled?: (id: string) => boolean;
  extra?: Partial<RuntimeModelCatalogDeps>;
}) {
  const fetchModels = vi.fn<Fetch>(
    options.fetch ?? (async (target) => [{ id: `${target.runtimeId}-model`, name: "Model" }]),
  );
  const onChanged = vi.fn<() => void>();
  const catalog = new RuntimeModelCatalog({
    getActiveRuntimeId: () => options.active ?? "claude",
    getAccounts: () => options.accounts,
    listModelsForRuntime: fetchModels,
    isModelDisabled: options.disabled ?? (() => false),
    onChanged,
    ...options.extra,
  });
  return { catalog, fetchModels, onChanged };
}

async function settle(catalog: RuntimeModelCatalog): Promise<ModelInfo[]> {
  catalog.listPeerModels();
  await vi.advanceTimersByTimeAsync(0);
  return catalog.listPeerModels();
}

describe("RuntimeModelCatalog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns nothing at first, fetches in the background and announces the models", async () => {
    const { catalog, fetchModels, onChanged } = makeCatalog({});

    expect(catalog.listPeerModels()).toEqual([]);
    expect(fetchModels).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);

    expect(onChanged).toHaveBeenCalled();
    expect(catalog.listPeerModels().map((model) => model.id)).toEqual([
      "codex:codex-model",
      "cursor:cursor-model",
    ]);
  });

  it("skips the active runtime's default account and every runtime when peers are not hosted", async () => {
    const claudeActive = makeCatalog({ active: "claude" });
    await settle(claudeActive.catalog);
    expect(claudeActive.fetchModels).not.toHaveBeenCalledWith({ runtimeId: "claude" });

    const copilot = makeCatalog({ active: "copilot" });
    expect(copilot.catalog.listPeerModels()).toEqual([]);
    expect(copilot.fetchModels).not.toHaveBeenCalled();
  });

  it("qualifies models per account and groups them, default accounts first", async () => {
    const accounts: RuntimeAccountsSettings = {
      claude: { accounts: [{ id: "max", label: "omer-max" }] },
      codex: { accounts: [{ id: "team", label: "Team" }], defaultAccountId: "team" },
    };
    const { catalog } = makeCatalog({
      active: "cursor",
      accounts,
      fetch: async () => [{ id: "m", name: "M" }],
    });

    const models = await settle(catalog);

    expect(models.map((model) => [model.id, model.runtime?.label])).toEqual([
      ["claude:m", "Claude Agent · Primary"],
      ["codex@team:m", "Codex · Team"],
      ["claude@max:m", "Claude Agent · omer-max"],
      ["codex@default:m", "Codex · Primary"],
    ]);
    expect(models[2]?.runtime).toEqual({
      runtimeId: "claude",
      accountId: "max",
      label: "Claude Agent · omer-max",
    });
  });

  it("fetches an account from its own client and a bare runtime from the original one", async () => {
    const { catalog, fetchModels } = makeCatalog({
      active: "cursor",
      accounts: { claude: { accounts: [{ id: "max" }] } },
    });
    await settle(catalog);

    expect(fetchModels).toHaveBeenCalledWith({ runtimeId: "claude" });
    expect(fetchModels).toHaveBeenCalledWith({ runtimeId: "claude", accountId: "max" });
    expect(fetchModels).toHaveBeenCalledWith({ runtimeId: "codex" });
  });

  it("drops disabled models and duplicate ids within a peer", async () => {
    const { catalog } = makeCatalog({
      active: "claude",
      disabled: (id) => id === "codex:blocked",
      fetch: async (target) =>
        target.runtimeId === "codex"
          ? [
              { id: "blocked", name: "Blocked" },
              { id: "ok", name: "Ok" },
            ]
          : [],
    });

    expect((await settle(catalog)).map((model) => model.id)).toEqual(["codex:ok"]);
  });

  it("omits a failing target without failing the rest and retries it after the failure cache", async () => {
    let signedIn = false;
    const { catalog, fetchModels } = makeCatalog({
      active: "claude",
      fetch: async (target) => {
        if (target.runtimeId === "cursor" && !signedIn) throw new Error("not signed in");
        return [{ id: "m", name: "M" }];
      },
    });

    expect((await settle(catalog)).map((model) => model.id)).toEqual(["codex:m"]);
    const callsAfterFirst = fetchModels.mock.calls.length;

    catalog.listPeerModels();
    expect(fetchModels).toHaveBeenCalledTimes(callsAfterFirst);

    signedIn = true;
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await settle(catalog)).map((model) => model.id)).toEqual(["codex:m", "cursor:m"]);
  });

  it("abandons a target that takes longer than the timeout", async () => {
    const { catalog } = makeCatalog({
      active: "claude",
      fetch: (target) =>
        target.runtimeId === "codex"
          ? new Promise(() => {})
          : Promise.resolve([{ id: "m", name: "M" }]),
    });

    catalog.listPeerModels();
    await vi.advanceTimersByTimeAsync(5_001);

    expect(catalog.listPeerModels().map((model) => model.id)).toEqual(["cursor:m"]);
  });

  it("serves the cache for ten minutes, then refreshes in the background", async () => {
    const { catalog, fetchModels } = makeCatalog({ active: "claude" });
    await settle(catalog);
    const initialCalls = fetchModels.mock.calls.length;

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    catalog.listPeerModels();
    expect(fetchModels).toHaveBeenCalledTimes(initialCalls);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const stale = catalog.listPeerModels();
    expect(stale).toHaveLength(2);
    expect(fetchModels).toHaveBeenCalledTimes(initialCalls * 2);
  });

  it("forgets everything on invalidate and ignores fetches that started before it", async () => {
    let resolveFirst: (models: ModelInfo[]) => void = () => {};
    const { catalog, fetchModels } = makeCatalog({
      active: "claude",
      fetch: (target) =>
        target.runtimeId === "codex" && fetchModels.mock.calls.length <= 2
          ? new Promise((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve([{ id: "new", name: "New" }]),
    });
    catalog.listPeerModels();
    catalog.invalidate();
    resolveFirst([{ id: "old", name: "Old" }]);

    expect((await settle(catalog)).map((model) => model.id)).toEqual(["codex:new", "cursor:new"]);
  });
});

describe("runtime group labels", () => {
  it("names the runtime alone until it has several accounts", () => {
    expect(runtimeGroupLabel(undefined, "codex")).toBe("Codex");
    const accounts: RuntimeAccountsSettings = { claude: { accounts: [{ id: "max" }] } };
    expect(runtimeGroupLabel(accounts, "claude", "max")).toBe("Claude Agent · max");
    expect(runtimeGroupLabel(accounts, "claude")).toBe("Claude Agent · Primary");
  });

  it("describes the active runtime's group by its default account", () => {
    const accounts: RuntimeAccountsSettings = {
      claude: { accounts: [{ id: "max", label: "omer-max" }], defaultAccountId: "max" },
    };
    expect(activeRuntimeGroup(accounts, "claude")).toEqual({
      runtimeId: "claude",
      accountId: "max",
      label: "Claude Agent · omer-max",
    });
    expect(activeRuntimeGroup(undefined, "copilot")).toEqual({
      runtimeId: "copilot",
      label: "Copilot",
    });
  });
});
