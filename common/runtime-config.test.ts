import { describe, expect, it } from "vitest";

import {
  BUILTIN_RUNTIME_IDS,
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  CURSOR_RUNTIME_ID,
  CURSOR_SDK_SUPPORTS_TRANSCRIPTION,
  canSwitchRuntimeLive,
  DEFAULT_RUNTIME_ID,
  FIRST_RUN_BROWSER_RUNTIME_CHOICES,
  getRuntimeMetadata,
  getRuntimeSelectionMetadata,
  isVoiceTranscriptionAvailable,
  resolveSessionRuntimeId,
} from "./runtime-config";

describe("runtime metadata", () => {
  it("publishes all product-facing built-in runtime IDs and labels", () => {
    expect(BUILTIN_RUNTIME_IDS).toEqual([
      "copilot",
      "gateway",
      "claude",
      "codex",
      "cursor",
      "marshal-cloud",
    ]);
    expect(getRuntimeMetadata(CLAUDE_RUNTIME_ID)).toMatchObject({
      displayName: "Claude Agent",
      compatibilityOrigin: "copilot",
      rendererRoot: "local",
      selectable: true,
    });
    expect(getRuntimeMetadata(CODEX_RUNTIME_ID)).toMatchObject({
      displayName: "Codex",
      compatibilityOrigin: "copilot",
      rendererRoot: "local",
      selectable: true,
    });
    expect(getRuntimeMetadata(CURSOR_RUNTIME_ID)).toMatchObject({
      displayName: "Cursor",
      compatibilityOrigin: "copilot",
      rendererRoot: "local",
      selectable: true,
    });
  });

  it("offers Claude browser and API-key login alongside Codex interactive methods", () => {
    const claude = getRuntimeMetadata(CLAUDE_RUNTIME_ID);
    expect(claude.auth.methods.map((method) => method.type)).toEqual(["browser", "api-key"]);
    expect(claude.auth.methods[0]?.label).toBe("Sign in with Claude");
    expect(claude.auth.setupInstructions).toContain("ANTHROPIC_API_KEY");
    expect(claude.auth.setupInstructions).toContain("Claude subscription");

    expect(getRuntimeMetadata(CODEX_RUNTIME_ID).auth.methods.map((method) => method.type)).toEqual([
      "browser",
      "device-code",
      "api-key",
    ]);
    expect(getRuntimeMetadata(CODEX_RUNTIME_ID).auth.methods[0]?.label).toBe(
      "Sign in with ChatGPT",
    );
    expect(FIRST_RUN_BROWSER_RUNTIME_CHOICES.map((choice) => choice.runtimeId)).toEqual([
      "codex",
      "cursor",
    ]);
  });

  it("lets Cursor sign in in the browser or paste a user API key", () => {
    const cursor = getRuntimeMetadata(CURSOR_RUNTIME_ID);
    expect(cursor.auth.methods.map((method) => method.type)).toEqual(["browser", "api-key"]);
    expect(cursor.auth.methods[0]?.label).toBe("Sign in with Cursor");
    expect(cursor.auth.methods[1]?.label).toBe("Use existing API key");
    expect(cursor.auth.setupInstructions).toContain("cursor.com/dashboard/api");
  });

  it("keeps unknown adapter IDs open-ended and routes them through generic local auth", () => {
    expect(getRuntimeMetadata("custom-runtime")).toMatchObject({
      id: "custom-runtime",
      displayName: "custom-runtime",
      rendererRoot: "local",
      selectable: false,
    });
    expect(getRuntimeSelectionMetadata("custom-runtime").map((runtime) => runtime.id)).toEqual([
      "copilot",
      "gateway",
      "claude",
      "codex",
      "cursor",
      "marshal-cloud",
      "custom-runtime",
    ]);
  });

  it("supports live switching across Copilot, Claude, Codex, and Cursor", () => {
    expect(canSwitchRuntimeLive("copilot", "codex")).toBe(true);
    expect(canSwitchRuntimeLive("claude", "copilot")).toBe(true);
    expect(canSwitchRuntimeLive("codex", "claude")).toBe(true);
    expect(canSwitchRuntimeLive("cursor", "copilot")).toBe(true);
    expect(canSwitchRuntimeLive("codex", "cursor")).toBe(true);
    expect(canSwitchRuntimeLive("copilot", "gateway")).toBe(false);
    expect(canSwitchRuntimeLive("gateway", "codex")).toBe(false);
  });
});

describe("legacy runtime resolution", () => {
  it("preserves runtimeId precedence and legacy origin/default fallbacks", () => {
    expect(resolveSessionRuntimeId({ runtimeId: "claude", backendOrigin: "copilot" })).toBe(
      "claude",
    );
    expect(resolveSessionRuntimeId({ backendOrigin: "gateway" })).toBe("gateway");
    expect(resolveSessionRuntimeId({})).toBe(DEFAULT_RUNTIME_ID);
  });
});

describe("isVoiceTranscriptionAvailable", () => {
  it("keeps compose-bar voice off until Cursor SDK adds speech-to-text", () => {
    expect(CURSOR_SDK_SUPPORTS_TRANSCRIPTION).toBe(false);
    expect(isVoiceTranscriptionAvailable(CURSOR_RUNTIME_ID)).toBe(false);
    expect(isVoiceTranscriptionAvailable(CODEX_RUNTIME_ID)).toBe(false);
    expect(isVoiceTranscriptionAvailable(undefined)).toBe(false);
  });

  it("enables voice only for Cursor when the SDK transcription flag is on", () => {
    expect(isVoiceTranscriptionAvailable(CURSOR_RUNTIME_ID, true)).toBe(true);
    expect(isVoiceTranscriptionAvailable(CODEX_RUNTIME_ID, true)).toBe(false);
  });
});
