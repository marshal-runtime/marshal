import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { PermissionAction } from "../common/marshal-constants";
import {
  ApprovalBroker,
  type BrokerRequest,
  type TransientApprovalBinding,
} from "./approval-broker";
import { makeRequest } from "./policy-rules/test-helpers";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeBrokerRequest(
  requestId: string,
  overrides: Partial<BrokerRequest> = {},
): BrokerRequest {
  return {
    permissionRequest: makeRequest({ id: requestId, sessionId: "session-A" }),
    requestId,
    sessionId: "session-A",
    ...overrides,
  };
}

// ── ApprovalBroker ──────────────────────────────────────────────────────────

describe("ApprovalBroker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── DEFAULT_TIMEOUT_MS ──────────────────────────────────────────────────

  it("DEFAULT_TIMEOUT_MS is 48 hours", () => {
    // Stopgap value — users were hitting the old 5-minute expiry on permission
    // cards before they could respond. Revisit when/if we remove auto-deny
    // entirely.
    expect(ApprovalBroker.DEFAULT_TIMEOUT_MS).toBe(48 * 60 * 60 * 1000);
  });

  it("uses DEFAULT_TIMEOUT_MS when no constructor override is provided", async () => {
    const broker = new ApprovalBroker();
    let settled = false;
    const promise = broker.requestPrompt(makeBrokerRequest("p1")).then((r) => {
      settled = true;
      return r;
    });

    // Advance to one tick before the default timeout — still pending
    await vi.advanceTimersByTimeAsync(ApprovalBroker.DEFAULT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    // One more tick crosses the threshold
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toEqual({ outcome: "timed-out" });
  });

  // ── requestPrompt + resolve ─────────────────────────────────────────────

  it("requestPrompt blocks until resolve is called", async () => {
    const broker = new ApprovalBroker();
    const req = makeBrokerRequest("p1");

    let resolved = false;
    const promise = broker.requestPrompt(req).then((r) => {
      resolved = true;
      return r;
    });

    // Not yet resolved
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    broker.resolve("p1", "allow");
    const result = await promise;
    expect(resolved).toBe(true);
    expect(result).toEqual({ outcome: "resolved", action: "allow" });
  });

  it("resolve with deny returns deny action", async () => {
    const broker = new ApprovalBroker();
    const promise = broker.requestPrompt(makeBrokerRequest("p1"));

    broker.resolve("p1", "deny");
    expect(await promise).toEqual({ outcome: "resolved", action: "deny" });
  });

  it("resolve with allow-session returns allow-session action", async () => {
    const broker = new ApprovalBroker();
    const promise = broker.requestPrompt(makeBrokerRequest("p1"));

    broker.resolve("p1", "allow-session");
    expect(await promise).toEqual({ outcome: "resolved", action: "allow-session" });
  });

  it("resolve with always-allow returns always-allow action", async () => {
    const broker = new ApprovalBroker();
    const promise = broker.requestPrompt(makeBrokerRequest("p1"));

    broker.resolve("p1", "always-allow");
    expect(await promise).toEqual({ outcome: "resolved", action: "always-allow" });
  });

  // ── resolveSilent ───────────────────────────────────────────────────────

  it("resolveSilent settles the promise with silent: true on the resolved outcome", async () => {
    const broker = new ApprovalBroker();
    const promise = broker.requestPrompt(makeBrokerRequest("p1"));

    expect(broker.resolveSilent("p1", "allow")).toBe(true);
    expect(await promise).toEqual({ outcome: "resolved", action: "allow", silent: true });
  });

  it("resolveSilent removes the request from pending and notifies listeners", async () => {
    const broker = new ApprovalBroker();
    const onResolved = vi.fn<(...args: unknown[]) => void>();
    broker.subscribe({ onResolved });
    void broker.requestPrompt(makeBrokerRequest("p1"));

    expect(broker.hasPending("p1")).toBe(true);
    broker.resolveSilent("p1", "allow");
    expect(broker.hasPending("p1")).toBe(false);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("resolveSilent returns false for unknown requestId", () => {
    const broker = new ApprovalBroker();
    expect(broker.resolveSilent("nope", "allow")).toBe(false);
  });

  it("resolveSilent returns false for already-resolved requestId", async () => {
    const broker = new ApprovalBroker();
    void broker.requestPrompt(makeBrokerRequest("p1"));

    expect(broker.resolveSilent("p1", "allow")).toBe(true);
    expect(broker.resolveSilent("p1", "allow")).toBe(false);
  });

  it("resolve returns true for pending request", () => {
    const broker = new ApprovalBroker();
    void broker.requestPrompt(makeBrokerRequest("p1"));
    expect(broker.resolve("p1", "allow")).toBe(true);
  });

  it("resolve returns false for unknown requestId", () => {
    const broker = new ApprovalBroker();
    expect(broker.resolve("unknown", "allow")).toBe(false);
  });

  it("resolve returns false for already-resolved requestId", async () => {
    const broker = new ApprovalBroker();
    void broker.requestPrompt(makeBrokerRequest("p1"));

    expect(broker.resolve("p1", "allow")).toBe(true);
    expect(broker.resolve("p1", "allow")).toBe(false);
  });

  // ── Timeout ─────────────────────────────────────────────────────────────

  it("auto-denies after timeout", async () => {
    const broker = new ApprovalBroker(100); // 100ms timeout
    const promise = broker.requestPrompt(makeBrokerRequest("p1"));

    await vi.advanceTimersByTimeAsync(100);

    expect(await promise).toEqual({ outcome: "timed-out" });
  });

  it("does not time out if resolved before timeout", async () => {
    const broker = new ApprovalBroker(100);
    const promise = broker.requestPrompt(makeBrokerRequest("p1"));

    broker.resolve("p1", "allow");
    await vi.advanceTimersByTimeAsync(200);

    expect(await promise).toEqual({ outcome: "resolved", action: "allow" });
  });

  it("resolve returns false after timeout", async () => {
    const broker = new ApprovalBroker(100);
    void broker.requestPrompt(makeBrokerRequest("p1"));

    await vi.advanceTimersByTimeAsync(100);

    expect(broker.resolve("p1", "allow")).toBe(false);
  });

  // ── hasPending ──────────────────────────────────────────────────────────

  it("hasPending returns true for pending request", () => {
    const broker = new ApprovalBroker();
    void broker.requestPrompt(makeBrokerRequest("p1"));
    expect(broker.hasPending("p1")).toBe(true);
  });

  it("hasPending returns false for unknown request", () => {
    const broker = new ApprovalBroker();
    expect(broker.hasPending("unknown")).toBe(false);
  });

  it("hasPending returns false after resolve", () => {
    const broker = new ApprovalBroker();
    void broker.requestPrompt(makeBrokerRequest("p1"));
    broker.resolve("p1", "allow");
    expect(broker.hasPending("p1")).toBe(false);
  });

  it("hasPending returns false after timeout", async () => {
    const broker = new ApprovalBroker(100);
    void broker.requestPrompt(makeBrokerRequest("p1"));
    await vi.advanceTimersByTimeAsync(100);
    expect(broker.hasPending("p1")).toBe(false);
  });

  // ── clearSession ────────────────────────────────────────────────────────

  it("clearSession denies all pending for that session", async () => {
    const broker = new ApprovalBroker();
    const p1 = broker.requestPrompt(makeBrokerRequest("p1", { sessionId: "s1" }));
    const p2 = broker.requestPrompt(makeBrokerRequest("p2", { sessionId: "s1" }));
    const p3 = broker.requestPrompt(makeBrokerRequest("p3", { sessionId: "s2" }));

    broker.clearSession("s1");

    expect(await p1).toEqual({ outcome: "resolved", action: "deny" });
    expect(await p2).toEqual({ outcome: "resolved", action: "deny" });
    // p3 is still pending (different session)
    expect(broker.hasPending("p3")).toBe(true);

    broker.resolve("p3", "allow");
    expect(await p3).toEqual({ outcome: "resolved", action: "allow" });
  });

  it("clearSession does nothing for unknown session", () => {
    const broker = new ApprovalBroker();
    void broker.requestPrompt(makeBrokerRequest("p1"));
    broker.clearSession("unknown-session");
    expect(broker.hasPending("p1")).toBe(true);
  });

  // ── Duplicate requestId guard ────────────────────────────────────────────

  it("duplicate requestId denies the first and replaces with the second", async () => {
    const broker = new ApprovalBroker();
    const p1 = broker.requestPrompt(makeBrokerRequest("dup"));
    const p2 = broker.requestPrompt(makeBrokerRequest("dup"));

    // First request was denied when the duplicate arrived
    expect(await p1).toEqual({ outcome: "resolved", action: "deny" });

    // Second request is the active one
    expect(broker.hasPending("dup")).toBe(true);
    broker.resolve("dup", "allow");
    expect(await p2).toEqual({ outcome: "resolved", action: "allow" });
  });

  // ── Multiple concurrent requests ────────────────────────────────────────

  it("handles multiple concurrent requests for same session", async () => {
    const broker = new ApprovalBroker();
    const p1 = broker.requestPrompt(makeBrokerRequest("p1"));
    const p2 = broker.requestPrompt(makeBrokerRequest("p2"));

    broker.resolve("p2", "deny");
    broker.resolve("p1", "allow");

    expect(await p1).toEqual({ outcome: "resolved", action: "allow" });
    expect(await p2).toEqual({ outcome: "resolved", action: "deny" });
  });

  // ── Event emission ──────────────────────────────────────────────────────

  it("emits onPending when prompt is created", () => {
    const broker = new ApprovalBroker();
    const onPending = vi.fn<(r: BrokerRequest) => void>();
    broker.subscribe({ onPending });

    const req = makeBrokerRequest("p1");
    void broker.requestPrompt(req);

    expect(onPending).toHaveBeenCalledOnce();
    expect(onPending).toHaveBeenCalledWith(req);
  });

  it("emits onResolved when prompt is resolved by user", () => {
    const broker = new ApprovalBroker();
    const onResolved = vi.fn<(id: string, action: PermissionAction) => void>();
    broker.subscribe({ onResolved });

    void broker.requestPrompt(makeBrokerRequest("p1"));
    broker.resolve("p1", "always-allow");

    expect(onResolved).toHaveBeenCalledOnce();
    expect(onResolved).toHaveBeenCalledWith("p1", "always-allow");
  });

  it("emits onTimeout when prompt times out", async () => {
    const broker = new ApprovalBroker(100);
    const onTimeout = vi.fn<(id: string) => void>();
    broker.subscribe({ onTimeout });

    void broker.requestPrompt(makeBrokerRequest("p1"));
    await vi.advanceTimersByTimeAsync(100);

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledWith("p1");
  });

  it("does not emit onResolved on timeout", async () => {
    const broker = new ApprovalBroker(100);
    const onResolved = vi.fn<() => void>();
    broker.subscribe({ onResolved });

    void broker.requestPrompt(makeBrokerRequest("p1"));
    await vi.advanceTimersByTimeAsync(100);

    expect(onResolved).not.toHaveBeenCalled();
  });

  it("emits onResolved for each pending when clearSession is called", async () => {
    const broker = new ApprovalBroker();
    const onResolved = vi.fn<(id: string, action: PermissionAction) => void>();
    broker.subscribe({ onResolved });

    void broker.requestPrompt(makeBrokerRequest("p1", { sessionId: "s1" }));
    void broker.requestPrompt(makeBrokerRequest("p2", { sessionId: "s1" }));

    broker.clearSession("s1");

    expect(onResolved).toHaveBeenCalledTimes(2);
    expect(onResolved).toHaveBeenCalledWith("p1", "deny");
    expect(onResolved).toHaveBeenCalledWith("p2", "deny");
  });

  // ── subscribe / unsubscribe ─────────────────────────────────────────────

  it("subscribe returns working unsubscribe function", () => {
    const broker = new ApprovalBroker();
    const onPending = vi.fn<() => void>();
    const unsubscribe = broker.subscribe({ onPending });

    void broker.requestPrompt(makeBrokerRequest("p1"));
    expect(onPending).toHaveBeenCalledOnce();

    unsubscribe();
    void broker.requestPrompt(makeBrokerRequest("p2"));
    expect(onPending).toHaveBeenCalledOnce(); // not called again
  });

  it("supports multiple listeners", () => {
    const broker = new ApprovalBroker();
    const listener1 = vi.fn<() => void>();
    const listener2 = vi.fn<() => void>();
    broker.subscribe({ onPending: listener1 });
    broker.subscribe({ onPending: listener2 });

    void broker.requestPrompt(makeBrokerRequest("p1"));
    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it("listener error does not prevent other listeners from being notified", () => {
    const broker = new ApprovalBroker();
    const errorListener = vi.fn<() => void>().mockImplementation(() => {
      throw new Error("boom");
    });
    const goodListener = vi.fn<() => void>();
    broker.subscribe({ onPending: errorListener });
    broker.subscribe({ onPending: goodListener });

    void broker.requestPrompt(makeBrokerRequest("p1"));

    expect(errorListener).toHaveBeenCalledOnce();
    expect(goodListener).toHaveBeenCalledOnce();
  });
});

// ── reportClassification ──────────────────────────────────────────────────────

describe("reportClassification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const classification = {
    explanation: "installs deps",
    category: "writes" as const,
    suggestedPattern: "npm install *",
    patternRationale: "install cmd",
    source: "llm" as const,
    guardrailRuleId: null,
  };

  it("emits onClassification for a pending prompt", () => {
    const broker = new ApprovalBroker();
    const listener = vi.fn<(id: string, c: unknown) => void>();
    broker.subscribe({ onClassification: listener });
    void broker.requestPrompt(makeBrokerRequest("p1"));

    broker.reportClassification("p1", classification);

    expect(listener).toHaveBeenCalledWith("p1", classification);
  });

  it("is a no-op when the prompt is no longer pending", () => {
    const broker = new ApprovalBroker();
    const listener = vi.fn<(id: string, c: unknown) => void>();
    broker.subscribe({ onClassification: listener });
    void broker.requestPrompt(makeBrokerRequest("p1"));
    broker.resolve("p1", "allow");

    broker.reportClassification("p1", classification);

    expect(listener).not.toHaveBeenCalled();
  });

  it("is a no-op when no prompt has ever been created", () => {
    const broker = new ApprovalBroker();
    const listener = vi.fn<(id: string, c: unknown) => void>();
    broker.subscribe({ onClassification: listener });

    broker.reportClassification("unknown-id", classification);

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not emit after unsubscribe", () => {
    const broker = new ApprovalBroker();
    const listener = vi.fn<(id: string, c: unknown) => void>();
    const unsubscribe = broker.subscribe({ onClassification: listener });
    void broker.requestPrompt(makeBrokerRequest("p1"));

    unsubscribe();
    broker.reportClassification("p1", classification);

    expect(listener).not.toHaveBeenCalled();
  });
});

// ── listPendingRequests ────────────────────────────────────────────────────

describe("listPendingRequests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns all pending entries when no sessionId is provided", () => {
    const broker = new ApprovalBroker();
    void broker.requestPrompt(makeBrokerRequest("p1"));
    void broker.requestPrompt(
      makeBrokerRequest("p2", {
        sessionId: "session-B",
        permissionRequest: makeRequest({ id: "p2", sessionId: "session-B" }),
      }),
    );

    const pending = broker.listPendingRequests();

    expect(pending.map((p) => p.requestId).sort()).toEqual(["p1", "p2"]);
  });

  it("filters by sessionId", () => {
    const broker = new ApprovalBroker();
    void broker.requestPrompt(makeBrokerRequest("p1")); // session-A
    void broker.requestPrompt(
      makeBrokerRequest("p2", {
        sessionId: "session-B",
        permissionRequest: makeRequest({ id: "p2", sessionId: "session-B" }),
      }),
    );

    const onlyA = broker.listPendingRequests("session-A");

    expect(onlyA.map((p) => p.requestId)).toEqual(["p1"]);
  });

  it("returns empty list after a request resolves", () => {
    const broker = new ApprovalBroker();
    void broker.requestPrompt(makeBrokerRequest("p1"));
    broker.resolve("p1", "allow");

    expect(broker.listPendingRequests()).toEqual([]);
  });

  it("includes the underlying ApprovalRequest payload", () => {
    const broker = new ApprovalBroker();
    const req = makeRequest({ id: "p1", sessionId: "session-A", command: "echo hello" });
    void broker.requestPrompt(makeBrokerRequest("p1", { permissionRequest: req }));

    const pending = broker.listPendingRequests();

    expect(pending).toHaveLength(1);
    expect(pending[0].permissionRequest).toBe(req);
  });
});

describe("transient approvals", () => {
  const binding: TransientApprovalBinding = {
    sessionId: "session-A",
    workspacePath: "Q:\\workspace",
    workspaceIdentity: {
      version: 1,
      device: "1",
      inode: "2",
      birthtimeNs: "3",
    },
    capability: "code.index.initialize",
    permissions: ["code.index.rebuild"],
    requestDigest: "digest",
  };

  it("coalesces only an exact pending transient binding", () => {
    const broker = new ApprovalBroker();
    const transient = {
      binding,
      expiresAt: Date.now() + 60_000,
      onResolution: () => true,
    };
    const first = broker.requestTransientPrompt(makeBrokerRequest("p1"), transient);
    const second = broker.requestTransientPrompt(makeBrokerRequest("p2"), transient);

    expect(first).toMatchObject({ requestId: "p1", created: true });
    expect(second).toMatchObject({ requestId: "p1", created: false });
    expect(broker.hasPending("p1")).toBe(true);
    expect(broker.hasPending("p2")).toBe(false);

    broker.resolve("p1", "allow");
    const third = broker.requestTransientPrompt(makeBrokerRequest("p3"), transient);
    expect(third).toMatchObject({ requestId: "p3", created: true });
    broker.drainAll();
  });

  it("cancels pending and retained transient approvals without retaining a proof", () => {
    const broker = new ApprovalBroker();
    const onResolution = vi.fn<() => boolean>().mockReturnValue(true);
    const onCancel = vi.fn<() => void>();
    const transient = {
      binding,
      expiresAt: Date.now() + 60_000,
      onResolution,
      onCancel,
    };
    broker.requestTransientPrompt(makeBrokerRequest("pending"), transient);
    expect(broker.cancelTransientApproval("pending")).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onResolution).not.toHaveBeenCalled();
    expect(broker.transientApprovalStatus("pending")).toBe("missing");

    broker.requestTransientPrompt(makeBrokerRequest("retained"), transient);
    broker.resolve("retained", "allow");
    expect(broker.transientApprovalStatus("retained")).toBe("approved");
    expect(broker.cancelTransientApproval("retained")).toBe(true);
    expect(broker.transientApprovalStatus("retained")).toBe("missing");
  });
});

// ── drainAll ──────────────────────────────────────────────────────────────────

describe("drainAll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains all pending prompts across sessions", async () => {
    const broker = new ApprovalBroker();
    const p1 = broker.requestPrompt(makeBrokerRequest("p1", { sessionId: "s1" }));
    const p2 = broker.requestPrompt(makeBrokerRequest("p2", { sessionId: "s2" }));

    broker.drainAll();

    expect(await p1).toEqual({ outcome: "resolved", action: "deny" });
    expect(await p2).toEqual({ outcome: "resolved", action: "deny" });
    expect(broker.hasPending("p1")).toBe(false);
    expect(broker.hasPending("p2")).toBe(false);
  });

  it("drains with custom action", async () => {
    const broker = new ApprovalBroker();
    const p1 = broker.requestPrompt(makeBrokerRequest("p1"));

    broker.drainAll("allow");

    expect(await p1).toEqual({ outcome: "resolved", action: "allow" });
  });

  it("emits onResolved for each drained prompt", () => {
    const broker = new ApprovalBroker();
    const onResolved = vi.fn<(id: string, action: PermissionAction) => void>();
    broker.subscribe({ onResolved });

    void broker.requestPrompt(makeBrokerRequest("p1"));
    void broker.requestPrompt(makeBrokerRequest("p2"));
    broker.drainAll();

    expect(onResolved).toHaveBeenCalledTimes(2);
    expect(onResolved).toHaveBeenCalledWith("p1", "deny");
    expect(onResolved).toHaveBeenCalledWith("p2", "deny");
  });

  it("clears timeout timers", async () => {
    const broker = new ApprovalBroker(100);
    const onTimeout = vi.fn<(id: string) => void>();
    broker.subscribe({ onTimeout });

    void broker.requestPrompt(makeBrokerRequest("p1"));
    broker.drainAll();

    // Timeout should not fire after drain
    await vi.advanceTimersByTimeAsync(200);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing is pending", () => {
    const broker = new ApprovalBroker();
    expect(() => broker.drainAll()).not.toThrow();
  });

  it("hasPending returns false inside onResolved listener (invariant)", () => {
    const broker = new ApprovalBroker();
    const seenPending: boolean[] = [];
    broker.subscribe({
      onResolved: (requestId) => {
        seenPending.push(broker.hasPending(requestId));
      },
    });

    void broker.requestPrompt(makeBrokerRequest("p1"));
    void broker.requestPrompt(makeBrokerRequest("p2"));
    broker.drainAll();

    // Both should see hasPending=false, consistent with resolve()
    expect(seenPending).toEqual([false, false]);
  });
});
