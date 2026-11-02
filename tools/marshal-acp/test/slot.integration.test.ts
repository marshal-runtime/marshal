import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { isToolUseAllowed } from "../src/permission-policy.ts";
import { runSlot } from "../src/slot.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.join(__dirname, "fixtures/fake-acp-agent.mjs");

describe("runSlot (integration with fake ACP child)", () => {
  it("captures session id and review body, denies blocked tool", async () => {
    const result = await runSlot({
      spawn: {
        cmd: process.execPath,
        args: [fakeAgent],
        env: { ...process.env, FAKE_REQUEST_CMD: "gh pr comment 1 -b nope" },
        cwd: process.cwd(),
      },
      prompt: "/marshal-code-review https://example.test/pull/1",
      isAllowed: (req) => isToolUseAllowed(req, { profile: "review" }),
      onUpdate: () => {},
      // Bound the slot lifetime so a hung fake-agent doesn't leak a child
      // process into the next test (vitest's testTimeout doesn't kill spawned
      // children).
      maxLifetimeMs: 5000,
    });
    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe("fake-session-1");
    expect(result.body).toContain("fake review body");
    expect(result.deniedRequests.length).toBeGreaterThanOrEqual(1);
  });

  it("allows a benign request", async () => {
    const result = await runSlot({
      spawn: {
        cmd: process.execPath,
        args: [fakeAgent],
        env: { ...process.env, FAKE_REQUEST_CMD: "gh pr view 1" },
        cwd: process.cwd(),
      },
      prompt: "/marshal-code-review https://example.test/pull/1",
      isAllowed: (req) => isToolUseAllowed(req, { profile: "review" }),
      onUpdate: () => {},
      // Bound the slot lifetime so a hung fake-agent doesn't leak a child
      // process into the next test (vitest's testTimeout doesn't kill spawned
      // children).
      maxLifetimeMs: 5000,
    });
    expect(result.status).toBe("completed");
    expect(result.deniedRequests).toEqual([]);
  });

  it("returns `failed` with the maxLifetimeMs reason when the agent hangs after initialize", async () => {
    const result = await runSlot({
      spawn: {
        cmd: process.execPath,
        args: [fakeAgent],
        // FAKE_HANG_AFTER_INIT makes the fake agent ack `initialize` and then
        // silently swallow every subsequent request. The slot's maxLifetimeMs
        // timer is the only way out — without it, this test would hang for
        // the whole vitest project timeout.
        env: { ...process.env, FAKE_HANG_AFTER_INIT: "1" },
        cwd: process.cwd(),
      },
      prompt: "/marshal-code-review https://example.test/pull/1",
      isAllowed: () => true,
      onUpdate: () => {},
      maxLifetimeMs: 300,
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/maxLifetimeMs/i);
  });

  it("falls back to session/new when session/load returns an error", async () => {
    const result = await runSlot({
      spawn: {
        cmd: process.execPath,
        args: [fakeAgent],
        env: {
          ...process.env,
          FAKE_REQUEST_CMD: "gh pr view 1",
          FAKE_SESSION_LOAD_FAILS: "1",
        },
        cwd: process.cwd(),
      },
      prompt: "/marshal-code-review https://example.test/pull/1",
      resumeSessionId: "fake-session-old",
      resumePrompt: "compare against prior findings (should NOT be sent)",
      isAllowed: (req) => isToolUseAllowed(req, { profile: "review" }),
      onUpdate: () => {},
      maxLifetimeMs: 5000,
    });
    expect(result.status).toBe("completed");
    // Fallback created a fresh session — the id was NOT the requested resume id.
    expect(result.sessionId).toBe("fake-session-fallback");
    expect(result.sessionId).not.toBe("fake-session-old");
    // Body comes from the fresh prompt, not the resume prompt (the fake agent
    // emits the same body either way, but the assertion guards against a
    // regression where the resume prompt is echoed into the body somehow).
    expect(result.body).toContain("fake review body");
  });
});
