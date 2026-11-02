import { describe, expect, it } from "vitest";

import {
  MODEL_ROUTING_RUNTIME_IDS,
  applyDefaultRuntimeAccount,
  detectModelProviderFamily,
  normalizeModelRuntimeRouting,
  preserveSessionRuntimeAccount,
  routeModelToRuntime,
} from "./model-runtime-routing";
import { MARSHAL_CLOUD_RUNTIME_ID } from "./runtime-config";
import { PEER_RUNTIME_IDS } from "./runtime-qualified-model";

describe("detectModelProviderFamily", () => {
  it.each([
    ["claude-opus-5-5[1m]", "anthropic"],
    ["opus", "anthropic"],
    ["Sonnet-4.5", "anthropic"],
    ["haiku-4", "anthropic"],
    ["gpt-5.6-luna", "openai"],
    ["o3-mini", "openai"],
    ["codex-mini-latest", "openai"],
    ["gemini-2.5-pro", "google"],
  ])("maps %s to %s", (model, family) => {
    expect(detectModelProviderFamily(model)).toBe(family);
  });

  it.each(["", "  ", "llama-3", "omni", "auto", undefined])("leaves %s unclassified", (model) => {
    expect(detectModelProviderFamily(model)).toBeUndefined();
  });
});

describe("routeModelToRuntime", () => {
  const routing = { anthropic: "claude", openai: "cursor" };

  it("qualifies a model whose family is routed to another runtime", () => {
    expect(routeModelToRuntime("gpt-5.6-luna", routing, "claude")).toBe("cursor:gpt-5.6-luna");
    expect(routeModelToRuntime("claude-opus-5-5[1m]", routing, "cursor")).toBe(
      "claude:claude-opus-5-5[1m]",
    );
  });

  it("leaves models routed to the active runtime unchanged", () => {
    expect(routeModelToRuntime("claude-opus-5-5[1m]", routing, "claude")).toBe(
      "claude-opus-5-5[1m]",
    );
  });

  it("leaves already-qualified ids unchanged", () => {
    expect(routeModelToRuntime("codex:gpt-5.5", routing, "claude")).toBe("codex:gpt-5.5");
  });

  it("keeps today's behavior when routing is unset or the family is unrouted", () => {
    expect(routeModelToRuntime("gpt-5.6-luna", undefined, "claude")).toBe("gpt-5.6-luna");
    expect(routeModelToRuntime("gpt-5.6-luna", {}, "claude")).toBe("gpt-5.6-luna");
    expect(routeModelToRuntime("gemini-2.5-pro", routing, "claude")).toBe("gemini-2.5-pro");
    expect(routeModelToRuntime("llama-3", routing, "claude")).toBe("llama-3");
  });

  it("does not qualify models when the active runtime cannot host peers", () => {
    expect(routeModelToRuntime("gpt-5.6-luna", routing, "copilot")).toBe("gpt-5.6-luna");
    expect(routeModelToRuntime("claude-opus-5-5[1m]", routing, "gateway")).toBe(
      "claude-opus-5-5[1m]",
    );
  });

  it("ignores routes to runtimes that cannot run as peers", () => {
    expect(routeModelToRuntime("gpt-5.6-luna", { openai: "copilot" }, "claude")).toBe(
      "gpt-5.6-luna",
    );
  });

  it("routes a family to an account, including one of the active runtime", () => {
    expect(routeModelToRuntime("opus", { anthropic: "claude@work" }, "cursor")).toBe(
      "claude@work:opus",
    );
    expect(routeModelToRuntime("opus", { anthropic: "claude@work" }, "claude")).toBe(
      "claude@work:opus",
    );
  });
});

describe("applyDefaultRuntimeAccount", () => {
  const accounts = {
    claude: { accounts: [{ id: "work" }], defaultAccountId: "work" },
    codex: { accounts: [{ id: "team" }] },
  };

  it("pins plain and runtime-qualified models to the runtime's default account", () => {
    expect(applyDefaultRuntimeAccount("opus", accounts, "claude")).toBe("claude@work:opus");
    expect(applyDefaultRuntimeAccount("claude:opus", accounts, "cursor")).toBe("claude@work:opus");
  });

  it("leaves models that name an account, including the original one", () => {
    expect(applyDefaultRuntimeAccount("claude@default:opus", accounts, "claude")).toBe(
      "claude@default:opus",
    );
    expect(applyDefaultRuntimeAccount("claude@home:opus", accounts, "claude")).toBe(
      "claude@home:opus",
    );
  });

  it("leaves runtimes that default to the original account, and empty models", () => {
    expect(applyDefaultRuntimeAccount("gpt-5.5", accounts, "codex")).toBe("gpt-5.5");
    expect(applyDefaultRuntimeAccount("", accounts, "claude")).toBe("");
    expect(applyDefaultRuntimeAccount("opus", undefined, "claude")).toBe("opus");
  });

  it("does nothing on runtimes that cannot host peers", () => {
    expect(applyDefaultRuntimeAccount("opus", accounts, "copilot")).toBe("opus");
  });
});

describe("preserveSessionRuntimeAccount", () => {
  const base = { activeRuntimeId: "claude" };

  it("keeps the session's account for a plain model on the same runtime", () => {
    expect(
      preserveSessionRuntimeAccount({
        ...base,
        requestedModel: "sonnet",
        routedModel: "sonnet",
        sessionModel: "claude@work:opus",
      }),
    ).toBe("claude@work:sonnet");
  });

  it("keeps an explicit pin to the original account past a configured default", () => {
    expect(
      preserveSessionRuntimeAccount({
        ...base,
        requestedModel: "sonnet",
        routedModel: "claude@work:sonnet",
        sessionModel: "claude@default:opus",
      }),
    ).toBe("claude@default:sonnet");
  });

  it("follows explicit requests and runtime changes", () => {
    expect(
      preserveSessionRuntimeAccount({
        ...base,
        requestedModel: "claude@home:sonnet",
        routedModel: "claude@home:sonnet",
        sessionModel: "claude@work:opus",
      }),
    ).toBe("claude@home:sonnet");
    expect(
      preserveSessionRuntimeAccount({
        ...base,
        requestedModel: "gpt-5.5",
        routedModel: "codex:gpt-5.5",
        sessionModel: "claude@work:opus",
      }),
    ).toBe("codex:gpt-5.5");
  });

  it("leaves sessions without an account to routing", () => {
    expect(
      preserveSessionRuntimeAccount({
        ...base,
        requestedModel: "sonnet",
        routedModel: "claude@work:sonnet",
        sessionModel: "opus",
      }),
    ).toBe("claude@work:sonnet");
  });
});

describe("normalizeModelRuntimeRouting", () => {
  it("keeps known families routed to peer runtimes", () => {
    expect(
      normalizeModelRuntimeRouting({
        anthropic: "claude",
        openai: "cursor",
        google: "gateway",
        mistral: "codex",
      }),
    ).toEqual({ anthropic: "claude", openai: "cursor" });
  });

  it("keeps routes to accounts and drops malformed account ids", () => {
    expect(
      normalizeModelRuntimeRouting({ anthropic: "claude@work", openai: "codex@Bad Id" }),
    ).toEqual({ anthropic: "claude@work" });
    expect(normalizeModelRuntimeRouting({ anthropic: "claude@default" })).toEqual({
      anthropic: "claude",
    });
  });

  it("returns undefined for empty or malformed routing", () => {
    expect(normalizeModelRuntimeRouting({})).toBeUndefined();
    expect(normalizeModelRuntimeRouting(undefined)).toBeUndefined();
    expect(normalizeModelRuntimeRouting(["cursor"])).toBeUndefined();
    expect(normalizeModelRuntimeRouting({ openai: 7 })).toBeUndefined();
  });

  it("offers every peer runtime except Marshal Cloud as routing targets", () => {
    expect(new Set(MODEL_ROUTING_RUNTIME_IDS)).toEqual(
      new Set([...PEER_RUNTIME_IDS].filter((id) => id !== MARSHAL_CLOUD_RUNTIME_ID)),
    );
  });
});
