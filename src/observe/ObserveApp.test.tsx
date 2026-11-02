import type { RuntimeUiAPI } from "@common/marshal-ipc-contract";
import { type RuntimeUiInstance, type RuntimeUiSnapshot } from "@common/runtime-ui";
import { SWARM_RUN_VIEW_RENDER_ID } from "@marshal/swarm/presentation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";

import { ObserveApp, parseObserveConfig } from "./ObserveApp";

const owner = {
  sessionId: "session-owner",
  workspaceName: "marshal",
  extensionId: "@marshal/code-review",
  applicationId: "codereview.prs",
};

const packagedHtml =
  '<html><head><meta name="viewport" content="width=device-width"></head><body><main><h1>Pull requests</h1></main></body></html>';

function packagedInstance(): RuntimeUiInstance {
  return {
    instanceId: "instance-1",
    owner,
    surface: "tab",
    idempotencyKey: "ui-observe:test",
    revision: 1,
    openedAt: "2026-09-13T08:00:00.000Z",
    updatedAt: "2026-09-13T08:00:00.000Z",
    focusedAt: "2026-09-13T08:00:00.000Z",
    content: {
      kind: "application",
      renderId: "codereview-prs",
      resource: { uri: "ui://code-review/prs", mimeType: "text/html", name: "Pull Requests" },
      descriptor: {
        version: "1.0.0",
        presentationModes: ["inline", "fullscreen"],
        actions: [],
        tools: [],
      },
    },
  };
}

function swarmInstance(): RuntimeUiInstance {
  return {
    ...packagedInstance(),
    owner: {
      sessionId: "session-owner",
      workspaceName: "marshal",
      extensionId: "@marshal/swarm",
      applicationId: "swarm-run",
    },
    content: {
      kind: "application",
      renderId: SWARM_RUN_VIEW_RENDER_ID,
      resource: { uri: "ui://marshal/swarm/run", mimeType: "text/html", name: "Swarm" },
      descriptor: {
        version: "1.0.0",
        presentationModes: ["pip"],
        actions: [],
        tools: [],
      },
      state: {
        run: {
          runId: "run-1",
          objective: "Verify observer rendering",
          scope: "workspace",
          state: "running",
          tasks: [],
        },
      },
    },
  };
}

function fakeRuntimeUiApi(instances: RuntimeUiInstance[]): RuntimeUiAPI {
  const snapshot = (): RuntimeUiSnapshot => ({
    scope: { sessionId: "session-owner", workspaceName: "marshal" },
    revision: instances.length,
    generatedAt: "2026-09-13T08:00:00.000Z",
    instances: [...instances],
    events: [],
  });
  const receipt = {
    receiptId: "receipt-1",
    action: "open" as const,
    status: "applied" as const,
    completedAt: "2026-09-13T08:00:00.000Z",
    revision: 1,
  };
  const api: Partial<RuntimeUiAPI> = {
    getSnapshot: vi.fn<RuntimeUiAPI["getSnapshot"]>(async () => ({
      success: true as const,
      value: snapshot(),
    })),
    subscribe: vi.fn<RuntimeUiAPI["subscribe"]>(async () => ({
      success: true as const,
      value: snapshot(),
    })),
    unsubscribe: vi.fn<RuntimeUiAPI["unsubscribe"]>(async () => ({ success: true as const })),
    activatePlacement: vi.fn<NonNullable<RuntimeUiAPI["activatePlacement"]>>(async () => {
      if (instances.length === 0) instances.push(packagedInstance());
      return {
        success: true as const,
        value: { receipt, instance: instances[0], instances: [...instances] },
      };
    }),
    list: vi.fn<RuntimeUiAPI["list"]>(async () => ({
      success: true as const,
      value: { receipt, instances: [...instances] },
    })),
    focus: vi.fn<RuntimeUiAPI["focus"]>(async () => ({
      success: true as const,
      value: { receipt, instance: instances[0] },
    })),
    close: vi.fn<RuntimeUiAPI["close"]>(async () => ({
      success: true as const,
      value: { receipt },
    })),
    invokeCapability: vi.fn<NonNullable<RuntimeUiAPI["invokeCapability"]>>(async () => ({
      success: true as const,
      value: { output: {} },
    })),
    readResource: vi.fn<NonNullable<RuntimeUiAPI["readResource"]>>(async () => ({
      success: true as const,
      value: {
        uri: "ui://code-review/prs",
        mimeType: "text/html",
        text: packagedHtml,
        revisionId: "revision-1",
        integrity: "sha256-fixture",
        viewports: ["mobile", "desktop"] as const,
      },
    })),
    onEvent: vi.fn<RuntimeUiAPI["onEvent"]>(() => () => {}),
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the fake implements every method the harness exercises
  return api as RuntimeUiAPI;
}

beforeEach(() => {
  installMockAPIs();
  document.documentElement.removeAttribute("data-observe-state");
});

describe("ObserveApp mounting (live-demo regression: stuck at 'Preparing observation…')", () => {
  it("initializes a built-in renderer and reports it rendered", async () => {
    const api = fakeRuntimeUiApi([swarmInstance()]);
    window.runtimeUiAPI = api;
    const ready = vi.fn<(info?: Record<string, unknown>) => void>();
    window.uiObserveAPI = { ready };
    render(
      <ObserveApp
        config={parseObserveConfig(
          "?mode=application&viewport=desktop&extensionId=%40marshal%2Fswarm&applicationId=swarm-run&sessionId=session-owner&workspaceName=marshal",
        )}
      />,
    );

    await waitFor(() => expect(ready).toHaveBeenCalledWith({ state: "rendered" }));
    expect(document.querySelector("[data-testid=runtime-ui-application]")).not.toBeNull();
    expect(document.querySelector("[data-testid=runtime-ui-packaged-frame]")).toBeNull();
  });

  it("activates the target, mounts the packaged sandbox iframe, and reports rendered", async () => {
    const api = fakeRuntimeUiApi([]);
    window.runtimeUiAPI = api;
    const ready = vi.fn<(info?: Record<string, unknown>) => void>();
    window.uiObserveAPI = { ready };
    render(
      <ObserveApp
        config={parseObserveConfig(
          "?mode=application&viewport=mobile&extensionId=%40marshal%2Fcode-review&applicationId=codereview.prs&sessionId=session-owner&workspaceName=marshal",
        )}
      />,
    );
    await waitFor(() => expect(api.activatePlacement).toHaveBeenCalledTimes(1));
    // M3: activation runs under the requester's session scope, never the
    // shared user scope, so scope-keyed extension state resolves like a real
    // bound pane.
    expect(api.activatePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-owner", workspaceName: "marshal" }),
    );
    // The REAL packaged pipeline must mount: sandbox iframe present with the
    // app's document — never a permanent "Preparing observation…" shell.
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>(
        "[data-testid=runtime-ui-packaged-frame]",
      );
      if (!element?.getAttribute("srcdoc")) throw new Error("packaged frame not mounted");
      return element;
    });
    expect(frame.getAttribute("srcdoc")).toContain("Pull requests");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(screen.queryByText(/Preparing observation/)).toBeNull();
    // Simulate the sandboxed document's bridge handshake + ui/initialize (the
    // real app performs these; happy-dom iframes execute no scripts).
    const nonce = /name="marshal-sandbox-nonce" content="([^"]+)"/.exec(
      frame.getAttribute("srcdoc") ?? "",
    )?.[1];
    expect(nonce).toBeTruthy();
    const post = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", { source: frame.contentWindow, origin: "null", data }),
      );
    post({ marshalSandbox: nonce });
    post({ jsonrpc: "2.0", id: "init", method: "ui/initialize", params: {} });
    // Settled-state contract for the capture guard.
    await waitFor(() => expect(document.documentElement.dataset.observeState).toBe("rendered"));
    // The created instance rides the ready signal so the window lifecycle can
    // close it on teardown (session-scoped observer instances never accumulate).
    await waitFor(() =>
      expect(ready).toHaveBeenCalledWith({
        state: "rendered",
        instanceId: "instance-1",
        created: true,
      }),
    );
    // The subscription must be stable — no teardown/resubscribe churn (the
    // live defect: a per-render scope identity looped the subscribe effect).
    expect(vi.mocked(api.subscribe).mock.calls.length).toBeLessThanOrEqual(2);
    expect(vi.mocked(api.unsubscribe).mock.calls.length).toBe(0);
  });

  it("surfaces activation failure as an error state instead of hanging in preparing", async () => {
    const api = fakeRuntimeUiApi([]);
    vi.mocked(api.activatePlacement).mockResolvedValue({
      success: false,
      error: { code: "not-found", message: "Navigation contribution is no longer available." },
    });
    window.runtimeUiAPI = api;
    const ready = vi.fn<(info?: Record<string, unknown>) => void>();
    window.uiObserveAPI = { ready };
    render(
      <ObserveApp
        config={parseObserveConfig(
          "?mode=application&viewport=mobile&extensionId=%40marshal%2Fcode-review&applicationId=codereview.prs&sessionId=session-owner&workspaceName=marshal",
        )}
      />,
    );
    await screen.findByRole("alert");
    await waitFor(() => expect(document.documentElement.dataset.observeState).toBe("error"));
    await waitFor(() => expect(ready).toHaveBeenCalledWith({ state: "error" }));
  });
});
