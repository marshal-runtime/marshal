import { describe, it, expect, vi, beforeEach } from "vitest";

import { DEFAULT_MODEL, ModelManager, type ModelManagerDeps } from "./model-manager";
import type { PersistedSession, SessionsIndex } from "./session-store";

/** Tracks withIndexLock calls — reset in beforeEach via createDeps(). */
let withIndexLockCalls = 0;

function createMockStore() {
  const defaultIndex: SessionsIndex = { sessions: [], activeSessionId: null };
  withIndexLockCalls = 0;

  return {
    loadIndex: vi.fn<() => SessionsIndex>(() => defaultIndex),
    // withIndexLock is generic (<T>) which makes vi.fn typing painful.
    // Use a plain async function that executes the callback synchronously.
    async withIndexLock<T>(fn: (index: SessionsIndex) => T): Promise<T> {
      withIndexLockCalls++;
      return fn(defaultIndex);
    },
    loadSessionData: vi.fn<(id: string) => PersistedSession | null>(() => null),
    saveSessionData: vi.fn<(session: PersistedSession) => void>(),
  };
}

function createDeps(overrides: Partial<ModelManagerDeps> = {}): ModelManagerDeps {
  return {
    store: createMockStore(),
    listModelsFromBackend: vi.fn<() => Promise<unknown[]>>(async () => []),
    getCachedModelsFromBackend: vi.fn<() => null>(() => null),
    getBackendDefaultModel: vi.fn<() => string | undefined>(() => undefined),
    getTenantPolicy: vi.fn<() => undefined>(() => undefined),
    ...overrides,
  };
}

describe("ModelManager", () => {
  let deps: ModelManagerDeps;
  let mm: ModelManager;

  beforeEach(() => {
    deps = createDeps();
    mm = new ModelManager(deps);
  });

  // ---------------------------------------------------------------------------
  // listModels
  // ---------------------------------------------------------------------------

  describe("listModels()", () => {
    it("normalizes discovered models and marks featured entries", async () => {
      const models = [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "claude-opus-4.7" },
        { id: "m2", name: "Model 2" },
        null,
      ];
      vi.mocked(deps.listModelsFromBackend).mockResolvedValue(models);
      const result = await mm.listModels();
      expect(result).toEqual([
        { id: "gpt-5.6", name: "GPT-5.6", featured: true },
        { id: "claude-opus-4.7", name: "claude-opus-4.7", featured: true },
        { id: "m2", name: "Model 2", featured: false },
      ]);
    });

    it("propagates errors from backend (error handling is in CopilotBackend)", async () => {
      vi.mocked(deps.listModelsFromBackend).mockRejectedValue(new Error("network"));
      await expect(mm.listModels()).rejects.toThrow("network");
    });

    it("normalizes long-context support and token limits from SDK billing metadata", async () => {
      vi.mocked(deps.listModelsFromBackend).mockResolvedValue([
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          capabilities: { limits: { max_context_window_tokens: 1_050_000 } },
          billing: {
            tokenPrices: {
              contextMax: 272_000,
              longContext: { contextMax: 922_000 },
            },
          },
        },
      ]);

      expect(await mm.listModels()).toEqual([
        expect.objectContaining({
          id: "gpt-5.6-sol",
          supportedContextTiers: ["default", "long_context"],
          contextWindowTokens: { default: 272_000, long_context: 1_050_000 },
        }),
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // isModelDisabled
  // ---------------------------------------------------------------------------

  describe("isModelDisabled()", () => {
    it("returns false when no tenant policy", () => {
      expect(mm.isModelDisabled("gpt-4")).toBe(false);
    });

    it("returns false when disabledModels is empty", () => {
      vi.mocked(deps.getTenantPolicy).mockReturnValue({ disabledModels: [] });
      expect(mm.isModelDisabled("gpt-4")).toBe(false);
    });

    it("returns true when model is in blocklist (case-insensitive)", () => {
      vi.mocked(deps.getTenantPolicy).mockReturnValue({
        disabledModels: ["GPT-4"],
      });
      expect(mm.isModelDisabled("gpt-4")).toBe(true);
      expect(mm.isModelDisabled("GPT-4")).toBe(true);
    });

    it("returns false when model is not in blocklist", () => {
      vi.mocked(deps.getTenantPolicy).mockReturnValue({
        disabledModels: ["gpt-4"],
      });
      expect(mm.isModelDisabled(DEFAULT_MODEL)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getDefaultModel
  // ---------------------------------------------------------------------------

  describe("getDefaultModel()", () => {
    it("uses GPT-5.6 Sol as the last-resort default", () => {
      expect(DEFAULT_MODEL).toBe("gpt-5.6-sol");
      expect(mm.getDefaultModel()).toBe("gpt-5.6-sol");
    });

    it("returns stored default when not disabled and the active backend can serve it", () => {
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        defaultModel: "gpt-4",
      });
      // Backend's cache must include the stored id — otherwise getDefaultModel
      // treats the stored value as unservicable and falls through to the
      // backend's polymorphic default (the bug Q2 fixes).
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue([{ id: "gpt-4" }]);
      expect(mm.getDefaultModel()).toBe("gpt-4");
    });

    it("ignores a stored default that the active backend can't serve and asks the backend for its own default", () => {
      // Concrete repro of the gpt-5 → gateway switch bug: stored gpt-5 isn't
      // in the gateway's cached model list; ModelManager must NOT return it,
      // OR every downstream session-create throws GatewayUnsupportedModelError.
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        defaultModel: "gpt-5",
      });
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue([{ id: "claude-sonnet-4-6" }]);
      vi.mocked(deps.getBackendDefaultModel).mockReturnValue("claude-sonnet-4-6");
      expect(mm.getDefaultModel()).toBe("claude-sonnet-4-6");
    });

    it("honors the stored default during the cold-start window (cache empty before first listModels)", () => {
      // Without this, the first session auto-created after launch lands on
      // DEFAULT_MODEL instead of the user's saved opus selection (gateway
      // path can substitute downstream, but copilot path can't).
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        defaultModel: "claude-opus-4.7",
      });
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(null);
      expect(mm.getDefaultModel()).toBe("claude-opus-4.7");
    });

    it("falls back to the system default when no model is stored and the backend has no opinion", () => {
      expect(mm.getDefaultModel()).toBe(DEFAULT_MODEL);
    });

    it("delegates to the backend's polymorphic default when stored is disabled by tenant policy", () => {
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        defaultModel: "blocked-model",
      });
      vi.mocked(deps.getTenantPolicy).mockReturnValue({
        disabledModels: ["blocked-model"],
      });
      vi.mocked(deps.getBackendDefaultModel).mockReturnValue("claude-opus-4.6");
      expect(mm.getDefaultModel()).toBe("claude-opus-4.6");
    });

    it("falls back to the system default when stored and backend defaults are unusable", () => {
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        defaultModel: "blocked",
      });
      vi.mocked(deps.getTenantPolicy).mockReturnValue({
        disabledModels: ["blocked", "also-blocked"],
      });
      vi.mocked(deps.getBackendDefaultModel).mockReturnValue("also-blocked");
      expect(mm.getDefaultModel()).toBe(DEFAULT_MODEL);
    });

    it("resolveDefaultModel warms a cold cache so the runtime's own default wins over DEFAULT_MODEL", async () => {
      let cache: { id: string }[] | null = null;
      vi.mocked(deps.getCachedModelsFromBackend).mockImplementation(() => cache);
      vi.mocked(deps.listModelsFromBackend).mockImplementation(async () => {
        cache = [{ id: "sonnet" }];
        return cache;
      });
      vi.mocked(deps.getBackendDefaultModel).mockImplementation(() => cache?.[0]?.id);

      expect(await mm.resolveDefaultModel()).toBe("sonnet");
      await mm.resolveDefaultModel();
      expect(deps.listModelsFromBackend).toHaveBeenCalledTimes(1);
    });

    it("resolveDefaultModel keeps the fallback chain when the model list is unavailable", async () => {
      vi.mocked(deps.listModelsFromBackend).mockRejectedValue(new Error("signed out"));
      expect(await mm.resolveDefaultModel()).toBe(DEFAULT_MODEL);
    });

    it("returns empty string when everything including hardcoded default is disabled", () => {
      vi.mocked(deps.getTenantPolicy).mockReturnValue({
        disabledModels: [DEFAULT_MODEL],
      });
      expect(mm.getDefaultModel()).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // setDefaultModel
  // ---------------------------------------------------------------------------

  describe("setDefaultModel()", () => {
    it("persists the model via withIndexLock and returns success", async () => {
      const result = await mm.setDefaultModel("gpt-4");
      expect(result).toEqual({ success: true });
      expect(withIndexLockCalls).toBe(1);
    });

    it("returns error when model is disabled by policy", async () => {
      vi.mocked(deps.getTenantPolicy).mockReturnValue({
        disabledModels: ["gpt-4"],
      });
      const result = await mm.setDefaultModel("gpt-4");
      expect(result.success).toBe(false);
      expect(result.error).toContain("disabled");
      expect(withIndexLockCalls).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // default reasoning effort
  // ---------------------------------------------------------------------------

  describe("default reasoning effort", () => {
    it("returns stored effort when the model supports it", () => {
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        defaultReasoningEfforts: { "claude-sonnet-4": "high" },
      });
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue([
        {
          id: "claude-sonnet-4",
          capabilities: { supports: { reasoningEffort: true } },
          supportedReasoningEfforts: ["low", "medium", "high"],
        },
      ]);

      expect(mm.getDefaultReasoningEffort("claude-sonnet-4")).toBe("high");
    });

    it("drops stored effort when cached metadata says the model does not support it", () => {
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        defaultReasoningEfforts: { "gpt-4o": "high" },
      });
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue([{ id: "gpt-4o" }]);

      expect(mm.getDefaultReasoningEffort("gpt-4o")).toBeUndefined();
    });

    it("keeps stored effort during cold start before the model cache is populated", () => {
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        defaultReasoningEfforts: { "claude-sonnet-4": "medium" },
      });
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(null);

      expect(mm.getDefaultReasoningEffort("claude-sonnet-4")).toBe("medium");
    });

    it("persists an override via withIndexLock", async () => {
      const result = await mm.setDefaultReasoningEffort("claude-sonnet-4", "high");

      expect(result).toEqual({ success: true });
      expect(deps.store.loadIndex().defaultReasoningEfforts).toEqual({
        "claude-sonnet-4": "high",
      });
    });

    it("clears an override when effort is undefined", async () => {
      await mm.setDefaultReasoningEffort("claude-sonnet-4", "high");

      const result = await mm.setDefaultReasoningEffort("claude-sonnet-4", undefined);

      expect(result).toEqual({ success: true });
      expect(deps.store.loadIndex().defaultReasoningEfforts).toBeUndefined();
    });

    it("rejects efforts that are not supported by cached model metadata", async () => {
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue([
        {
          id: "claude-sonnet-4",
          capabilities: { supports: { reasoningEffort: true } },
          supportedReasoningEfforts: ["low", "medium"],
        },
      ]);

      const result = await mm.setDefaultReasoningEffort("claude-sonnet-4", "high");

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not support");
    });
  });

  describe("context tier", () => {
    const contextModels = [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        supportedContextTiers: ["default", "long_context"],
      },
      { id: "gpt-4o", name: "GPT-4o", supportedContextTiers: ["default"] },
    ];

    it("defaults GPT-5.6 Sol to long context", () => {
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(contextModels);

      expect(mm.resolveContextTier({ tier: "chat", model: "gpt-5.6-sol" })).toBe("long_context");
    });

    it("keeps models without long-context support on the default tier", () => {
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(contextModels);

      expect(mm.resolveContextTier({ tier: "chat", model: "gpt-4o" })).toBe("default");
    });

    it("persists and resolves a per-model context default", async () => {
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(contextModels);

      expect(await mm.setDefaultContextTier("gpt-5.6-sol", "default")).toEqual({
        success: true,
      });
      expect(mm.getDefaultContextTier("gpt-5.6-sol")).toBe("default");
      expect(mm.resolveContextTier({ tier: "chat", model: "gpt-5.6-sol" })).toBe("default");
    });

    it("rejects long context for an unsupported model", async () => {
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(contextModels);

      const result = await mm.setDefaultContextTier("gpt-4o", "long_context");

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not support");
    });
  });

  // ---------------------------------------------------------------------------
  // Tiered defaults (subagent / workflow)
  // ---------------------------------------------------------------------------

  describe("tiered defaults", () => {
    const cachedReasoningModels = [
      {
        id: "gpt-5.5",
        capabilities: { supports: { reasoningEffort: true } },
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "claude-opus-4.7",
        capabilities: { supports: { reasoningEffort: true } },
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
      { id: "gpt-4o" },
    ];

    it("getTierDefaultModel falls back to the chat default when the tier is unset", () => {
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        defaultModel: "gpt-5.5",
      });
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue([{ id: "gpt-5.5" }]);

      expect(mm.getTierDefaultModel("subagent")).toBe("gpt-5.5");
      expect(mm.getTierDefaultModel("workflow")).toBe("gpt-5.5");
    });

    it("getTierDefaultModel honors a stored tier model", () => {
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        defaultModel: "gpt-5.5",
        workflowDefaults: { model: "claude-opus-4.7" },
      });
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue([
        { id: "gpt-5.5" },
        { id: "claude-opus-4.7" },
      ]);

      expect(mm.getTierDefaultModel("workflow")).toBe("claude-opus-4.7");
      expect(mm.getTierDefaultModel("subagent")).toBe("gpt-5.5");
    });

    it("resolveReasoningEffort prefers a per-session override", () => {
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(cachedReasoningModels);
      expect(
        mm.resolveReasoningEffort({ tier: "subagent", model: "gpt-5.5", sessionOverride: "low" }),
      ).toBe("low");
    });

    it("resolveReasoningEffort uses the tier default when no override", () => {
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        subagentDefaults: { reasoningEffort: "medium" },
      });
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(cachedReasoningModels);
      expect(mm.resolveReasoningEffort({ tier: "subagent", model: "gpt-5.5" })).toBe("medium");
    });

    it("resolveReasoningEffort falls back to High when nothing is configured", () => {
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(cachedReasoningModels);
      expect(mm.resolveReasoningEffort({ tier: "workflow", model: "claude-opus-4.7" })).toBe(
        "high",
      );
    });

    it("resolveReasoningEffort defaults GPT-5.6 Sol to Max", () => {
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue([
        {
          id: "gpt-5.6-sol",
          capabilities: { supports: { reasoningEffort: true } },
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        },
      ]);

      expect(mm.resolveReasoningEffort({ tier: "chat", model: "gpt-5.6-sol" })).toBe("max");
    });

    it("resolveReasoningEffort returns undefined for models without reasoning effort", () => {
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(cachedReasoningModels);
      expect(mm.resolveReasoningEffort({ tier: "subagent", model: "gpt-4o" })).toBeUndefined();
    });

    it("resolveReasoningEffort trusts High optimistically during cold start", () => {
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(null);
      expect(mm.resolveReasoningEffort({ tier: "chat", model: "gpt-5.5" })).toBe("high");
    });

    it("persists tier model + reasoning via withIndexLock and reads them back", async () => {
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(cachedReasoningModels);

      const modelResult = await mm.setTierDefaultModel("subagent", "gpt-5.5");
      const effortResult = await mm.setTierDefaultReasoningEffort("subagent", "high");

      expect(modelResult).toEqual({ success: true });
      expect(effortResult).toEqual({ success: true });
      expect(mm.getTierDefaults("subagent")).toEqual({
        model: "gpt-5.5",
        reasoningEffort: "high",
      });
    });

    it("rejects an unsupported tier reasoning effort", async () => {
      vi.mocked(deps.store.loadIndex).mockReturnValue({
        sessions: [],
        activeSessionId: null,
        subagentDefaults: { model: "gpt-4o" },
      });
      vi.mocked(deps.getCachedModelsFromBackend).mockReturnValue(cachedReasoningModels);

      const result = await mm.setTierDefaultReasoningEffort("subagent", "high");
      expect(result.success).toBe(false);
      expect(result.error).toContain("does not support");
    });
  });

  // ---------------------------------------------------------------------------
  // getSessionModel
  // ---------------------------------------------------------------------------

  describe("getSessionModel()", () => {
    it("returns undefined when session not found", () => {
      expect(mm.getSessionModel("s1")).toBeUndefined();
    });

    it("returns session model when set", () => {
      vi.mocked(deps.store.loadSessionData).mockReturnValue({
        id: "s1",
        name: "Test",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        hasUnread: false,
        isActive: false,
        messages: [],
        model: "gpt-4",
      });
      expect(mm.getSessionModel("s1")).toBe("gpt-4");
    });
  });

  // ---------------------------------------------------------------------------
  // validateAndPersistSessionModel
  // ---------------------------------------------------------------------------

  describe("validateAndPersistSessionModel()", () => {
    it("throws when session not found", () => {
      expect(() => mm.validateAndPersistSessionModel("s1", "gpt-4")).toThrow("Session not found");
    });

    it("allows changing the model when the session has messages", () => {
      const session: PersistedSession = {
        id: "s1",
        name: "Test",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        hasUnread: false,
        isActive: false,
        messages: [{ id: "m1", role: "user", content: "hi", timestamp: "2025-01-01" }],
      };
      vi.mocked(deps.store.loadSessionData).mockReturnValue(session);

      mm.validateAndPersistSessionModel("s1", "gpt-4");

      expect(session.model).toBe("gpt-4");
      expect(deps.store.saveSessionData).toHaveBeenCalledWith(session);
    });

    it("throws when model is disabled by tenant policy", () => {
      vi.mocked(deps.store.loadSessionData).mockReturnValue({
        id: "s1",
        name: "Test",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        hasUnread: false,
        isActive: false,
        messages: [],
      });
      vi.mocked(deps.getTenantPolicy).mockReturnValue({ disabledModels: ["gpt-4"] });
      expect(() => mm.validateAndPersistSessionModel("s1", "gpt-4")).toThrow("disabled by tenant");
    });

    it("persists model and returns soul", () => {
      const session = {
        id: "s1",
        name: "Test",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        hasUnread: false,
        isActive: false,
        messages: [],
        soul: "operator",
      };
      vi.mocked(deps.store.loadSessionData).mockReturnValue(session);

      const result = mm.validateAndPersistSessionModel("s1", "gpt-4");

      expect(result).toEqual({ soul: "operator" });
      expect(deps.store.saveSessionData).toHaveBeenCalledOnce();
      expect(deps.store.saveSessionData).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-4" }),
      );
    });
  });
});
