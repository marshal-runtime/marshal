import type { InvocationContext } from "@marshal/runtime";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeUiInstance } from "../common/runtime-ui";
import {
  UI_OBSERVE_CAPTURE,
  createUiObserveProvider,
  type UiObserveDeps,
  type UiObserveWindowHandle,
} from "./ui-observe";

const PNG_BASE64 = Buffer.from("fake-png-bytes").toString("base64");

function sessionContext(sessionId?: string, workspaceName = "marshal"): InvocationContext {
  return {
    principal: { id: "agent", kind: "user" },
    ...(sessionId ? { scope: { sessionId } } : { scope: {} }),
    metadata: { marshalWorkspaceName: workspaceName },
  };
}

function sessionInstance(sessionId: string): RuntimeUiInstance {
  return {
    instanceId: "instance-1",
    owner: {
      sessionId,
      workspaceName: "marshal",
      extensionId: "marshal.react-ui",
      applicationId: "card-abc",
    },
    surface: "inline-card",
    idempotencyKey: "open-1",
    revision: 1,
    openedAt: "2026-09-13T08:00:00.000Z",
    updatedAt: "2026-09-13T08:00:00.000Z",
    focusedAt: "2026-09-13T08:00:00.000Z",
    content: {
      kind: "application",
      renderId: "card-abc",
      resource: { uri: "ui://cards/abc", mimeType: "text/html", name: "Status card" },
      descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
    },
  };
}

function harness(overrides: Partial<UiObserveDeps> = {}) {
  const capture = vi.fn<UiObserveDeps["capture"]>(async () => ({
    pngBase64: PNG_BASE64,
    width: 390,
    height: 844,
  }));
  const audit = vi.fn<UiObserveDeps["audit"]>();
  const deps: UiObserveDeps = {
    findPublishedApplication: vi.fn<UiObserveDeps["findPublishedApplication"]>(
      async (extensionId, applicationId) =>
        extensionId === "@marshal/code-review" && applicationId === "codereview.prs"
          ? { viewports: new Set(["mobile", "desktop"] as const) }
          : undefined,
    ),
    findScopedInstance: vi.fn<UiObserveDeps["findScopedInstance"]>(async (scope, instanceId) =>
      scope.sessionId === "session-owner" && instanceId === "instance-1"
        ? sessionInstance("session-owner")
        : undefined,
    ),
    capture,
    audit,
    ...overrides,
  };
  return { provider: createUiObserveProvider(deps), deps, capture, audit };
}

describe("ui.observe.capture provider", () => {
  it("lists a discoverable descriptor with closed input and output schemas", async () => {
    const { provider } = harness();
    const descriptors = await provider.list(sessionContext("s-1"));
    const descriptor = descriptors.find((entry) => entry.name === UI_OBSERVE_CAPTURE);
    expect(descriptor).toBeDefined();
    expect(descriptor!.inputSchema).toMatchObject({ additionalProperties: false });
    expect(descriptor!.outputSchema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(["pngBase64", "width", "height", "viewport"]),
    });
    expect(provider.get!(UI_OBSERVE_CAPTURE, sessionContext("s-1"))).toBeDefined();
  });

  it("captures a published extension application at the requested viewport", async () => {
    const { provider, capture, audit } = harness();
    const result = await provider.invoke(
      UI_OBSERVE_CAPTURE,
      {
        extensionId: "@marshal/code-review",
        applicationId: "codereview.prs",
        viewport: "mobile",
        settleMs: 250,
      },
      sessionContext("session-owner"),
    );
    expect(result.output).toMatchObject({
      pngBase64: PNG_BASE64,
      width: 390,
      height: 844,
      viewport: "mobile",
    });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "application",
        extensionId: "@marshal/code-review",
        applicationId: "codereview.prs",
        viewport: "mobile",
        settleMs: 250,
        // M3: the observer mounts under the REQUESTER's session scope so the
        // extension executes with the same effective read authority a real
        // pane bound to that session would have (accounts/connections are
        // scope-keyed). User scope is only the sessionless fallback.
        scope: { sessionId: "session-owner", workspaceName: "marshal" },
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approved", viewport: "mobile" }),
    );
  });

  it("rejects unpublished applications — arbitrary URLs are never capturable", async () => {
    const { provider, capture, audit } = harness();
    await expect(
      provider.invoke(
        UI_OBSERVE_CAPTURE,
        { extensionId: "@evil/ext", applicationId: "https://evil.example", viewport: "desktop" },
        sessionContext("session-owner"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(capture).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ decision: "denied" }));
  });

  it("refuses a mobile capture of an application that declares no mobile view", async () => {
    const { provider, capture } = harness({
      findPublishedApplication: vi.fn<UiObserveDeps["findPublishedApplication"]>(async () => ({
        viewports: new Set(["desktop"] as const),
      })),
    });
    await expect(
      provider.invoke(
        UI_OBSERVE_CAPTURE,
        {
          extensionId: "@marshal/code-review",
          applicationId: "codereview.prs",
          viewport: "mobile",
        },
        sessionContext("session-owner"),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("observes session-owned instances only within the owning lineage", async () => {
    const { provider, capture } = harness();
    const owned = await provider.invoke(
      UI_OBSERVE_CAPTURE,
      { instanceId: "instance-1", viewport: "desktop" },
      sessionContext("session-owner"),
    );
    expect(owned.output).toMatchObject({ viewport: "desktop" });
    // A different session cannot observe it — and the error does not reveal
    // whether the instance exists.
    await expect(
      provider.invoke(
        UI_OBSERVE_CAPTURE,
        { instanceId: "instance-1", viewport: "desktop" },
        sessionContext("session-intruder"),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("validates the input shape: XOR target, bounded settle, closed keys", async () => {
    const { provider } = harness();
    const bad = [
      { viewport: "mobile" },
      { instanceId: "i", extensionId: "e", applicationId: "a", viewport: "mobile" },
      { extensionId: "@marshal/code-review", applicationId: "codereview.prs", viewport: "tv" },
      {
        extensionId: "@marshal/code-review",
        applicationId: "codereview.prs",
        viewport: "mobile",
        settleMs: 60_000,
      },
      {
        extensionId: "@marshal/code-review",
        applicationId: "codereview.prs",
        viewport: "mobile",
        url: "https://evil.example",
      },
    ];
    for (const input of bad) {
      // eslint-disable-next-line no-await-in-loop -- sequential assertion per malformed input
      await expect(
        provider.invoke(UI_OBSERVE_CAPTURE, input, sessionContext("session-owner")),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("bounds the returned image and audits the rejection", async () => {
    const { provider, audit } = harness({
      capture: vi.fn<UiObserveDeps["capture"]>(async () => ({
        pngBase64: "A".repeat(13_000_000),
        width: 390,
        height: 844,
      })),
    });
    await expect(
      provider.invoke(
        UI_OBSERVE_CAPTURE,
        {
          extensionId: "@marshal/code-review",
          applicationId: "codereview.prs",
          viewport: "mobile",
        },
        sessionContext("session-owner"),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ decision: "denied" }));
  });
});

describe("ui.observe.open / close — interactive observer sessions", () => {
  function sessionHarness(overrides: Partial<UiObserveDeps> = {}) {
    const destroyed: string[] = [];
    const openWindow = vi.fn<NonNullable<UiObserveDeps["openWindow"]>>(async (request) => ({
      webContentsId: 42,
      urlMarker: `marker-${request.viewport}`,
      width: request.viewport === "mobile" ? 390 : 1280,
      height: request.viewport === "mobile" ? 844 : 800,
      capture: vi.fn<UiObserveWindowHandle["capture"]>(async () => ({
        pngBase64: PNG_BASE64,
        width: 390,
        height: 844,
      })),
      destroy: vi.fn<UiObserveWindowHandle["destroy"]>(() => {
        destroyed.push(request.viewport);
      }),
    }));
    const resolveCdpTargetId = vi.fn<NonNullable<UiObserveDeps["resolveCdpTargetId"]>>(
      async (marker) => `cdp-${marker}`,
    );
    const base = harness({ openWindow, resolveCdpTargetId, ...overrides });
    return { ...base, openWindow, resolveCdpTargetId, destroyed };
  }
  const openInput = {
    extensionId: "@marshal/code-review",
    applicationId: "codereview.prs",
    viewport: "mobile" as const,
  };

  it("opens an observer session with a CDP target on the observer window only", async () => {
    const { provider, openWindow, resolveCdpTargetId, audit } = sessionHarness();
    const result = await provider.invoke(
      "ui.observe.open",
      { ...openInput, ttlMs: 60_000 },
      sessionContext("session-owner"),
    );
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
    const output = result.output as {
      observerSessionId: string;
      cdpTargetId: string | null;
      expiresAt: string;
    };
    expect(output.observerSessionId).toMatch(/.+/);
    expect(output.cdpTargetId).toBe("cdp-marker-mobile");
    expect(Date.parse(output.expiresAt)).toBeGreaterThan(Date.now());
    expect(openWindow).toHaveBeenCalledWith(expect.objectContaining({ viewport: "mobile" }));
    expect(resolveCdpTargetId).toHaveBeenCalledWith("marker-mobile");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approved", reason: "session-open" }),
    );
    await provider.invoke(
      "ui.observe.close",
      { observerSessionId: output.observerSessionId },
      sessionContext("session-owner"),
    );
  });

  it("enforces the concurrent observer cap", async () => {
    const { provider } = sessionHarness();
    const opened: string[] = [];
    for (let index = 0; index < 3; index++) {
      // eslint-disable-next-line no-await-in-loop -- sequential session opens
      const result = await provider.invoke(
        "ui.observe.open",
        openInput,
        sessionContext("session-owner"),
      );
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
      opened.push((result.output as { observerSessionId: string }).observerSessionId);
    }
    await expect(
      provider.invoke("ui.observe.open", openInput, sessionContext("session-owner")),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    for (const observerSessionId of opened) {
      // eslint-disable-next-line no-await-in-loop -- sequential cleanup
      await provider.invoke(
        "ui.observe.close",
        { observerSessionId },
        sessionContext("session-owner"),
      );
    }
  });

  it("only the opening scope may capture or close an observer session", async () => {
    const { provider, destroyed, audit } = sessionHarness();
    const result = await provider.invoke(
      "ui.observe.open",
      openInput,
      sessionContext("session-owner"),
    );
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
    const observerSessionId = (result.output as { observerSessionId: string }).observerSessionId;
    await expect(
      provider.invoke(
        UI_OBSERVE_CAPTURE,
        { observerSessionId, viewport: "mobile" },
        sessionContext("session-intruder"),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      provider.invoke(
        "ui.observe.close",
        { observerSessionId },
        sessionContext("session-intruder"),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(destroyed).toHaveLength(0);
    const captured = await provider.invoke(
      UI_OBSERVE_CAPTURE,
      { observerSessionId, viewport: "mobile" },
      sessionContext("session-owner"),
    );
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
    expect((captured.output as { pngBase64: string }).pngBase64).toBe(PNG_BASE64);
    const closed = await provider.invoke(
      "ui.observe.close",
      { observerSessionId },
      sessionContext("session-owner"),
    );
    expect(closed.output).toMatchObject({ closed: true });
    expect(destroyed).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approved", reason: "session-close" }),
    );
  });

  it("expires sessions on their TTL and audits the expiry", async () => {
    vi.useFakeTimers();
    try {
      const { provider, destroyed, audit } = sessionHarness();
      await provider.invoke(
        "ui.observe.open",
        { ...openInput, ttlMs: 5_000 },
        sessionContext("session-owner"),
      );
      await vi.advanceTimersByTimeAsync(5_100);
      expect(destroyed).toHaveLength(1);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ decision: "approved", reason: "session-expired" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the TTL and rejects unknown observer sessions", async () => {
    const { provider } = sessionHarness();
    await expect(
      provider.invoke(
        "ui.observe.open",
        { ...openInput, ttlMs: 86_400_000 },
        sessionContext("session-owner"),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      provider.invoke(
        "ui.observe.close",
        { observerSessionId: "nonexistent" },
        sessionContext("session-owner"),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

describe("stuck-observer guard (live-demo regression: capture of the loading shell)", () => {
  it("fails one-shot capture with the renderer's failed_precondition and audits the denial", async () => {
    const { provider, audit } = harness({
      capture: vi.fn<UiObserveDeps["capture"]>(async () => {
        throw Object.assign(
          new Error("The observer never rendered the application (state: preparing)."),
          { code: "failed_precondition" },
        );
      }),
    });
    await expect(
      provider.invoke(
        UI_OBSERVE_CAPTURE,
        {
          extensionId: "@marshal/code-review",
          applicationId: "codereview.prs",
          viewport: "mobile",
        },
        sessionContext("session-owner"),
      ),
    ).rejects.toMatchObject({ code: "failed_precondition" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        reason: expect.stringContaining("never rendered"),
      }),
    );
  });

  it("fails ui.observe.open when the observer window cannot settle", async () => {
    const { provider, audit } = harness({
      openWindow: vi.fn<NonNullable<UiObserveDeps["openWindow"]>>(async () => {
        throw Object.assign(
          new Error("The observer never rendered the application (state: preparing)."),
          { code: "failed_precondition" },
        );
      }),
      resolveCdpTargetId: vi.fn<NonNullable<UiObserveDeps["resolveCdpTargetId"]>>(async () => null),
    });
    await expect(
      provider.invoke(
        "ui.observe.open",
        {
          extensionId: "@marshal/code-review",
          applicationId: "codereview.prs",
          viewport: "mobile",
        },
        sessionContext("session-owner"),
      ),
    ).rejects.toMatchObject({ code: "failed_precondition" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ decision: "denied" }));
  });
});

describe("M3: observer execution scope (account-backed capabilities)", () => {
  it("falls back to user scope only when the requester has no session", async () => {
    const { provider, capture } = harness();
    await provider.invoke(
      UI_OBSERVE_CAPTURE,
      { extensionId: "@marshal/code-review", applicationId: "codereview.prs", viewport: "desktop" },
      sessionContext(undefined),
    );
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { applicationScope: "user", workspaceName: "marshal" },
      }),
    );
  });

  it("opens interactive observer sessions under the requester's session scope too", async () => {
    const openWindow = vi.fn<NonNullable<UiObserveDeps["openWindow"]>>(async () => ({
      webContentsId: 42,
      urlMarker: "marker",
      width: 390,
      height: 844,
      capture: vi.fn<UiObserveWindowHandle["capture"]>(async () => ({
        pngBase64: PNG_BASE64,
        width: 390,
        height: 844,
      })),
      destroy: vi.fn<UiObserveWindowHandle["destroy"]>(),
    }));
    const { provider } = harness({
      openWindow,
      resolveCdpTargetId: vi.fn<NonNullable<UiObserveDeps["resolveCdpTargetId"]>>(async () => null),
    });
    const result = await provider.invoke(
      "ui.observe.open",
      { extensionId: "@marshal/code-review", applicationId: "codereview.prs", viewport: "mobile" },
      sessionContext("session-owner"),
    );
    expect(openWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { sessionId: "session-owner", workspaceName: "marshal" },
      }),
    );
    await provider.invoke(
      "ui.observe.close",
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
      { observerSessionId: (result.output as { observerSessionId: string }).observerSessionId },
      sessionContext("session-owner"),
    );
  });
});
