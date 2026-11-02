import { describe, expect, it, vi } from "vitest";

// system-message transitively reaches electron app paths and the skills store;
// neither matters for the prompt-context lines under test.
vi.mock("./skills", () => ({
  getSkillsForSystemPrompt: vi.fn<() => string>(() => ""),
}));

import {
  getSessionClientViewport,
  setSessionClientViewport,
  viewportForSenderId,
} from "./client-viewport";
import { buildUserPromptContext } from "./system-message";

describe("session client viewport", () => {
  it("derives the viewport from the dispatching surface", () => {
    // Remote-access sockets get negative sender ids; renderer WebContents ids
    // are positive.
    expect(viewportForSenderId(-1)).toBe("mobile");
    expect(viewportForSenderId(-42)).toBe("mobile");
    expect(viewportForSenderId(1)).toBe("desktop");
    expect(viewportForSenderId(7)).toBe("desktop");
  });

  it("tracks the last surface that spoke per session and defaults to desktop", () => {
    expect(getSessionClientViewport("viewport-session-a")).toBe("desktop");
    setSessionClientViewport("viewport-session-a", "mobile");
    expect(getSessionClientViewport("viewport-session-a")).toBe("mobile");
    setSessionClientViewport("viewport-session-a", "desktop");
    expect(getSessionClientViewport("viewport-session-a")).toBe("desktop");
    expect(getSessionClientViewport("viewport-session-b")).toBe("desktop");
  });
});

describe("per-turn viewport context", () => {
  it("tells the agent it serves a phone and to default generated UI to mobile", () => {
    const { modifiedPrompt } = buildUserPromptContext("build me a status card", {
      timeZone: "UTC",
      clientViewport: "mobile",
    });
    expect(modifiedPrompt).toContain("mobile client");
    expect(modifiedPrompt).toContain("marshal.ui.viewports");
    expect(modifiedPrompt).toMatch(/build the phone view/i);
    expect(modifiedPrompt).toContain("views: {mobile, desktop}");
  });

  it("adds no viewport noise for desktop turns", () => {
    const { modifiedPrompt } = buildUserPromptContext("build me a status card", {
      timeZone: "UTC",
      clientViewport: "desktop",
    });
    expect(modifiedPrompt).not.toContain("mobile client");
    const unset = buildUserPromptContext("hello", { timeZone: "UTC" });
    expect(unset.modifiedPrompt).not.toContain("mobile client");
  });
});
