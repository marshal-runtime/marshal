import type { RuntimeUiInstance } from "@common/runtime-ui";
import { describe, expect, it, vi } from "vitest";

import { createPackagedUiBridge } from "./packagedUiBridge";
import type { RuntimeUiApplicationRenderHost } from "./RuntimeUiApplicationRegistry";

function fixture(
  overrides: Partial<RuntimeUiApplicationRenderHost> = {},
  bridgeOptions: Partial<Parameters<typeof createPackagedUiBridge>[0]> = {},
) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const onChromeHint = vi.fn<(chrome: "compact" | "hidden") => void>();
  const instance: RuntimeUiInstance = {
    instanceId: "instance",
    owner: {
      sessionId: "session",
      workspaceName: "workspace",
      extensionId: "@sample/ext",
      applicationId: "app",
    },
    surface: "tab",
    revision: 1,
    openedAt: "now",
    focusedAt: "now",
    updatedAt: "now",
    idempotencyKey: "open",
    content: {
      kind: "application",
      renderId: "sample",
      resource: { uri: "ui://sample/app", mimeType: "text/html" },
      descriptor: {
        version: "1.0.0",
        presentationModes: ["inline"],
        actions: [],
        tools: [{ id: "echo", name: "sample.echo", inputSchema: {} }],
      },
    },
  };
  const invoke = vi
    .fn<RuntimeUiApplicationRenderHost["invokeCapability"]>()
    .mockResolvedValue({ output: "result" });
  const cancel = vi
    .fn<NonNullable<RuntimeUiApplicationRenderHost["cancelCapability"]>>()
    .mockResolvedValue();
  const unsubscribe = vi.fn<() => void>();
  const host: RuntimeUiApplicationRenderHost = {
    instance,
    editor: { id: "test", SourceEditor: () => null },
    invokeCapability: invoke,
    cancelCapability: cancel,
    readResource: vi.fn<RuntimeUiApplicationRenderHost["readResource"]>(),
    subscribe: () => unsubscribe,
    focus: vi.fn<RuntimeUiApplicationRenderHost["focus"]>(),
    close: vi.fn<RuntimeUiApplicationRenderHost["close"]>(),
    update: vi.fn<RuntimeUiApplicationRenderHost["update"]>(),
    ...overrides,
  };
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  const bridge = createPackagedUiBridge({
    frame,
    nonce: "nonce",
    host: () => host,
    onReady: vi.fn<() => void>(),
    onError: vi.fn<(message: string) => void>(),
    onChromeHint,
    ...bridgeOptions,
  });
  const send = (
    data: unknown,
    source: MessageEventSource | null = frame.contentWindow,
    origin = "null",
  ) => window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
  const initialize = (params: Record<string, unknown> = {}) => {
    send({ marshalSandbox: "nonce" });
    send({ jsonrpc: "2.0", id: "init", method: "ui/initialize", params });
  };
  return {
    frame,
    host,
    post,
    invoke,
    cancel,
    unsubscribe,
    onChromeHint,
    send,
    initialize,
    dispose: () => {
      bridge.dispose();
      frame.remove();
    },
  };
}

describe("OMR2-2 host chrome opt-in via ui/initialize", () => {
  it("reports the app's hostChrome opt-in so the host can collapse its title+identity chrome", async () => {
    const f = fixture();
    f.initialize({ hostChrome: "hidden" });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ id: "init" }), "*"),
    );
    expect(f.onChromeHint).toHaveBeenCalledTimes(1);
    expect(f.onChromeHint).toHaveBeenCalledWith("hidden");
    f.dispose();
  });

  it("keeps full chrome when the app sends no hint or an unknown hostChrome value", async () => {
    const none = fixture();
    none.initialize();
    await vi.waitFor(() =>
      expect(none.post).toHaveBeenCalledWith(expect.objectContaining({ id: "init" }), "*"),
    );
    expect(none.onChromeHint).not.toHaveBeenCalled();
    none.dispose();
    const unknown = fixture();
    unknown.initialize({ hostChrome: "chromeless-superwide" });
    await vi.waitFor(() =>
      expect(unknown.post).toHaveBeenCalledWith(expect.objectContaining({ id: "init" }), "*"),
    );
    expect(unknown.onChromeHint).not.toHaveBeenCalled();
    unknown.dispose();
  });
});

describe("OMR2-1 on-demand session picker", () => {
  it("§7 guard: ui/requestSessionSelection summons the visible native picker and never mints a selection itself", async () => {
    const requestSessionPicker = vi.fn<() => void>();
    const selectSession = vi.fn<NonNullable<RuntimeUiApplicationRenderHost["selectSession"]>>();
    const f = fixture({ requestSessionPicker, selectSession });
    f.initialize();
    f.send({ jsonrpc: "2.0", id: "picker", method: "ui/requestSessionSelection", params: {} });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({ id: "picker", result: { status: "requested" } }),
        "*",
      ),
    );
    expect(requestSessionPicker).toHaveBeenCalledTimes(1);
    expect(selectSession).not.toHaveBeenCalled();
    f.dispose();
  });

  it("rejects ui/requestSessionSelection when the host has no native picker", async () => {
    const f = fixture();
    f.initialize();
    f.send({ jsonrpc: "2.0", id: "picker", method: "ui/requestSessionSelection", params: {} });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "picker",
          error: expect.objectContaining({
            message: "The native session picker is unavailable in this host.",
          }),
        }),
        "*",
      ),
    );
    f.dispose();
  });

  it("summons the native picker when a capability fails because a session grant is required, and still surfaces the failure", async () => {
    const requestSessionPicker = vi.fn<() => void>();
    const f = fixture({ requestSessionPicker });
    f.initialize();
    f.invoke.mockRejectedValueOnce(
      Object.assign(
        new Error("Select the target session in the native host picker before sending."),
        { code: "permission-denied" },
      ),
    );
    f.send({
      jsonrpc: "2.0",
      id: "needs-grant",
      method: "tools/call",
      params: { name: "sample.echo", arguments: {} },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "needs-grant",
          error: expect.objectContaining({
            message: "Select the target session in the native host picker before sending.",
          }),
        }),
        "*",
      ),
    );
    expect(requestSessionPicker).toHaveBeenCalledTimes(1);
    f.dispose();
  });

  it("summons the native picker when a nav-opened app calls a session-scoped capability without a session", async () => {
    const requestSessionPicker = vi.fn<() => void>();
    const f = fixture({ requestSessionPicker });
    f.initialize();
    f.invoke.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Select an execution session in the native application toolbar to use session-scoped host capabilities.",
        ),
        { code: "permission-denied" },
      ),
    );
    f.send({
      jsonrpc: "2.0",
      id: "needs-execution-session",
      method: "tools/call",
      params: { name: "sample.echo", arguments: {} },
    });
    await vi.waitFor(() => expect(requestSessionPicker).toHaveBeenCalledTimes(1));
    f.dispose();
  });

  it("does not summon the picker for unrelated capability failures", async () => {
    const requestSessionPicker = vi.fn<() => void>();
    const f = fixture({ requestSessionPicker });
    f.initialize();
    f.invoke.mockRejectedValueOnce(
      Object.assign(new Error("Approval needed"), { code: "approval-required" }),
    );
    f.send({
      jsonrpc: "2.0",
      id: "other-failure",
      method: "tools/call",
      params: { name: "sample.echo", arguments: {} },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({ id: "other-failure", error: expect.anything() }),
        "*",
      ),
    );
    expect(requestSessionPicker).not.toHaveBeenCalled();
    f.dispose();
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- stream fixtures cast loosely typed postMessage payloads */
describe("CF-05 host stream push: owner-scoped forwarding into the application iframe", () => {
  function streamEvent(overrides: Record<string, unknown> = {}) {
    return {
      type: "delivery-stream",
      sequence: 1,
      occurredAt: "now",
      scope: { sessionId: "session", workspaceName: "workspace" },
      owner: {
        sessionId: "session",
        workspaceName: "workspace",
        extensionId: "@sample/ext",
        applicationId: "app",
      },
      requestId: "codereview:pr-8:ask-1",
      streamSequence: 1,
      chunk: { kind: "text", text: "The " },
      terminal: false,
      ...overrides,
    } as unknown as Parameters<Parameters<RuntimeUiApplicationRenderHost["subscribe"]>[0]>[0];
  }

  it("forwards a streaming delivery's chunks to the owning application UI with correlation id, ordering, and terminal event", () => {
    let listener: ((event: unknown) => void) | undefined;
    const f = fixture({
      subscribe: (candidate) => {
        listener = candidate as (event: unknown) => void;
        return () => {};
      },
    });
    f.initialize();
    f.post.mockClear();

    listener!(streamEvent());
    listener!(streamEvent({ streamSequence: 2, chunk: { kind: "text", text: "answer" } }));
    listener!(
      streamEvent({
        streamSequence: 3,
        chunk: { kind: "status", text: "processed" },
        terminal: true,
        terminalState: "processed",
      }),
    );

    const notifications = f.post.mock.calls
      .map(([message]) => message as { method?: string; params?: Record<string, unknown> })
      .filter((message) => message.method === "ui/notifications/delivery-stream")
      .map((message) => message.params!);
    expect(notifications).toHaveLength(3);
    expect(notifications.every((params) => params.requestId === "codereview:pr-8:ask-1")).toBe(
      true,
    );
    expect(notifications.map((params) => params.streamSequence)).toEqual([1, 2, 3]);
    expect(notifications.map((params) => (params.chunk as { text?: string }).text)).toEqual([
      "The ",
      "answer",
      "processed",
    ]);
    expect(notifications.map((params) => params.terminal)).toEqual([false, false, true]);
    expect(notifications[2]?.terminalState).toBe("processed");
  });

  it("never forwards another owner's chunks: different extension, different application, or different scope", () => {
    let listener: ((event: unknown) => void) | undefined;
    const f = fixture({
      subscribe: (candidate) => {
        listener = candidate as (event: unknown) => void;
        return () => {};
      },
    });
    f.initialize();
    f.post.mockClear();

    listener!(
      streamEvent({
        owner: {
          sessionId: "session",
          workspaceName: "workspace",
          extensionId: "@other/ext",
          applicationId: "app",
        },
      }),
    );
    listener!(
      streamEvent({
        owner: {
          sessionId: "session",
          workspaceName: "workspace",
          extensionId: "@sample/ext",
          applicationId: "other-app",
        },
      }),
    );

    const notifications = f.post.mock.calls
      .map(([message]) => message as { method?: string })
      .filter((message) => message.method === "ui/notifications/delivery-stream");
    expect(notifications).toHaveLength(0);
  });
});
/* eslint-enable @typescript-eslint/no-unsafe-type-assertion */

describe("packaged UI bridge", () => {
  it("exposes selected images as owned resources and rejects unselected handles", async () => {
    const readImage = vi
      .fn<NonNullable<RuntimeUiApplicationRenderHost["readImage"]>>()
      .mockResolvedValue({ mimeType: "image/png", data: "aW1hZ2U=" });
    const f = fixture({
      selectedImages: [
        {
          handle: "owned",
          mimeType: "image/png",
          displayName: "Screenshot",
          byteLength: 5,
          expiresAt: "later",
        },
      ],
      readImage,
    });
    f.initialize();
    f.send({
      jsonrpc: "2.0",
      id: "image",
      method: "resources/read",
      params: { uri: "marshal-ui-image://owned" },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "image",
          result: {
            contents: [
              { uri: "marshal-ui-image://owned", mimeType: "image/png", blob: "aW1hZ2U=" },
            ],
          },
        }),
        "*",
      ),
    );
    f.send({
      jsonrpc: "2.0",
      id: "foreign",
      method: "resources/read",
      params: { uri: "marshal-ui-image://foreign" },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "foreign",
          error: expect.objectContaining({
            message: "This image was not selected for the application.",
          }),
        }),
        "*",
      ),
    );
    expect(readImage).toHaveBeenCalledTimes(1);
    f.dispose();
  });

  it("retains a machine-readable approval error for authored clients", async () => {
    const f = fixture();
    f.initialize();
    f.invoke.mockRejectedValueOnce(
      Object.assign(new Error("Approval needed"), { code: "approval-required" }),
    );
    f.send({
      jsonrpc: "2.0",
      id: "approval",
      method: "tools/call",
      params: { name: "sample.echo", arguments: {} },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "approval",
          error: { code: -32000, message: "Approval needed", data: { code: "approval-required" } },
        }),
        "*",
      ),
    );
    f.dispose();
  });

  it("routes bounded session search and selection through the owned host lifecycle", async () => {
    const searchSessions = vi
      .fn<NonNullable<RuntimeUiApplicationRenderHost["searchSessions"]>>()
      .mockResolvedValue([{ sessionId: "acme-1", title: "Acme review" }]);
    const selectSession = vi
      .fn<NonNullable<RuntimeUiApplicationRenderHost["selectSession"]>>()
      .mockResolvedValue({ grantId: "grant-1", sessionId: "acme-1", title: "Acme review" });
    const getSelectedSession = vi
      .fn<NonNullable<RuntimeUiApplicationRenderHost["getSelectedSession"]>>()
      .mockResolvedValue({ grantId: "grant-1", sessionId: "acme-1", title: "Acme review" });
    const f = fixture({ searchSessions, selectSession, getSelectedSession });
    f.initialize();
    f.send({
      jsonrpc: "2.0",
      id: "search",
      method: "ui/searchSessions",
      params: { query: "acme", limit: 5 },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "search",
          result: { sessions: [{ sessionId: "acme-1", title: "Acme review" }] },
        }),
        "*",
      ),
    );
    f.send({
      jsonrpc: "2.0",
      id: "select",
      method: "ui/selectSession",
      params: { targetSessionId: "acme-1" },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "select",
          error: expect.objectContaining({
            message: expect.stringContaining("native host picker"),
          }),
        }),
        "*",
      ),
    );
    f.send({ jsonrpc: "2.0", id: "selected", method: "ui/getSelectedSession", params: {} });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "selected",
          result: { grantId: "grant-1", sessionId: "acme-1", title: "Acme review" },
        }),
        "*",
      ),
    );
    expect(searchSessions).toHaveBeenCalledWith("acme", 5);
    expect(selectSession).not.toHaveBeenCalled();
    expect(getSelectedSession).toHaveBeenCalledTimes(1);
    f.dispose();
  });

  it("opens an existing session on request and hides why a session could not be opened", async () => {
    const openSession = vi
      .fn<NonNullable<RuntimeUiApplicationRenderHost["openSession"]>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Session not found"));
    const f = fixture({ openSession });
    f.initialize();
    f.send({
      jsonrpc: "2.0",
      id: "open",
      method: "ui/openSession",
      params: { sessionId: "acme-1" },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ id: "open", result: {} }), "*"),
    );
    f.send({
      jsonrpc: "2.0",
      id: "missing",
      method: "ui/openSession",
      params: { sessionId: "gone" },
    });
    f.send({ jsonrpc: "2.0", id: "empty", method: "ui/openSession", params: { sessionId: " " } });
    await vi.waitFor(() => {
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "missing",
          error: expect.objectContaining({ message: "The session could not be opened." }),
        }),
        "*",
      );
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "empty",
          error: expect.objectContaining({ message: "A session ID is required." }),
        }),
        "*",
      );
    });
    expect(openSession.mock.calls).toEqual([["acme-1"], ["gone"]]);
    f.dispose();
  });

  it("requires the frame source, opaque origin, and per-document handshake before dispatch", async () => {
    const f = fixture();
    const call = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "sample.echo", arguments: {} },
    };
    f.send(call);
    f.send({ marshalSandbox: "nonce" }, window);
    f.send({ marshalSandbox: "wrong" });
    f.send(call);
    expect(f.invoke).not.toHaveBeenCalled();
    f.initialize();
    f.send(call, window);
    f.send(call, f.frame.contentWindow, "https://other.example");
    expect(f.invoke).not.toHaveBeenCalled();
    f.send(call);
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(1));
    f.dispose();
  });

  it("denies undeclared tools and cancels pending work on cancellation and teardown", async () => {
    const f = fixture();
    f.initialize();
    f.send({
      jsonrpc: "2.0",
      id: "forbidden",
      method: "tools/call",
      params: { name: "shell.execute", arguments: {} },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "forbidden",
          error: expect.objectContaining({
            message: "The application has not declared this capability.",
          }),
        }),
        "*",
      ),
    );
    expect(f.invoke).not.toHaveBeenCalled();
    f.invoke.mockImplementation(() => new Promise(() => undefined));
    const call = (id: string) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "sample.echo", arguments: {} },
    });
    f.send(call("first"));
    f.send(call("first"));
    expect(f.invoke).toHaveBeenCalledTimes(1);
    f.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "first" } });
    expect(f.cancel).toHaveBeenCalledWith("packaged-ui:nonce:first");
    f.send(call("second"));
    f.dispose();
    expect(f.cancel).toHaveBeenCalledWith("packaged-ui:nonce:second");
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("authored render-plane tools", () => {
  const componentHtml =
    '<!doctype html><html><head><meta name="marshal-props" content="">' +
    '<meta http-equiv="Content-Security-Policy" content="script-src \'sha256-pinned\'">' +
    '<title>t</title></head><body><main id="root"></main><script>render()</script></body></html>';

  function authoredFixture() {
    return fixture({
      instance: {
        instanceId: "instance",
        owner: {
          sessionId: "session",
          workspaceName: "workspace",
          extensionId: "marshal.react-ui",
          applicationId: "sample",
        },
        surface: "tab",
        revision: 1,
        openedAt: "now",
        focusedAt: "now",
        updatedAt: "now",
        idempotencyKey: "open",
        content: {
          kind: "application",
          renderId: "sample",
          resource: {
            uri: "ui://marshal-react/runtime-renderer/1/index.html",
            mimeType: "text/html",
          },
          descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
        },
      },
    });
  }

  it("returns the payload adapter result verbatim with the component sandboxed for nested mounting", async () => {
    const f = authoredFixture();
    f.initialize();
    f.invoke.mockResolvedValueOnce({
      output: {
        content: [{ type: "text", text: "Compiled React payload ready." }],
        structuredContent: {
          props: { label: "hi" },
          marshal: { kind: "compiled_react_ui", componentHtml, componentId: "c1" },
        },
      },
    });
    f.send({
      jsonrpc: "2.0",
      id: "payload",
      method: "tools/call",
      params: { name: "marshal_get_react_payload", arguments: { renderId: "sample" } },
    });
    const payloadResult = (componentExpectation: unknown) =>
      expect.objectContaining({
        id: "payload",
        result: expect.objectContaining({
          content: [{ type: "text", text: "Compiled React payload ready." }],
          structuredContent: expect.objectContaining({
            marshal: expect.objectContaining({
              kind: "compiled_react_ui",
              componentHtml: componentExpectation,
            }),
          }),
        }),
      });
    await vi.waitFor(() => {
      expect(f.post).toHaveBeenCalledWith(
        payloadResult(expect.stringContaining("application/x-marshal-bundle")),
        "*",
      );
    });
    expect(f.post).toHaveBeenCalledWith(
      payloadResult(expect.stringContaining('name="marshal-props" content=""')),
      "*",
    );
    expect(f.post).not.toHaveBeenCalledWith(
      payloadResult(expect.stringContaining("sha256-pinned")),
      "*",
    );
    expect(f.post).toHaveBeenCalledWith(
      payloadResult(expect.stringContaining("default-src 'none'")),
      "*",
    );
    expect(f.post).toHaveBeenCalledWith(
      payloadResult(expect.stringContaining("connect-src 'none'")),
      "*",
    );
    expect(f.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "marshal_get_react_payload",
        input: { renderId: "sample" },
      }),
    );
    f.dispose();
  });

  it("never grants render-plane routing to extension-published applications", async () => {
    const f = fixture();
    f.initialize();
    f.send({
      jsonrpc: "2.0",
      id: "extension-payload",
      method: "tools/call",
      params: { name: "marshal_get_react_payload", arguments: { renderId: "sample" } },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "extension-payload",
          error: expect.objectContaining({
            message: "The application has not declared this capability.",
          }),
        }),
        "*",
      ),
    );
    f.send({
      jsonrpc: "2.0",
      id: "extension-action",
      method: "tools/call",
      params: {
        name: "marshal_invoke_react_action",
        arguments: { renderId: "sample", actionId: "anything", input: {} },
      },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "extension-action",
          error: expect.objectContaining({
            message: "The application has not declared this capability.",
          }),
        }),
        "*",
      ),
    );
    expect(f.invoke).not.toHaveBeenCalled();
    f.dispose();
  });

  it("passes action results through verbatim and pins the render identity", async () => {
    const f = authoredFixture();
    f.initialize();
    f.invoke.mockResolvedValueOnce({
      output: {
        content: [{ type: "text", text: "Action list-renders completed." }],
        structuredContent: { status: "success" },
      },
    });
    f.send({
      jsonrpc: "2.0",
      id: "action",
      method: "tools/call",
      params: {
        name: "marshal_invoke_react_action",
        arguments: { renderId: "sample", actionId: "list-renders", input: {} },
      },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "action",
          result: {
            content: [{ type: "text", text: "Action list-renders completed." }],
            structuredContent: { status: "success" },
          },
        }),
        "*",
      ),
    );
    f.send({
      jsonrpc: "2.0",
      id: "foreign",
      method: "tools/call",
      params: {
        name: "marshal_invoke_react_action",
        arguments: { renderId: "other-render", actionId: "list-renders", input: {} },
      },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "foreign",
          error: expect.objectContaining({
            message: "The application has not declared this capability.",
          }),
        }),
        "*",
      ),
    );
    expect(f.invoke).toHaveBeenCalledTimes(1);
    f.dispose();
  });
});

describe("display mode and content height", () => {
  it("accepts app-requested fullscreen through the embedder and reflects it in host context", async () => {
    const onDisplayModeRequest = vi
      .fn<(mode: "inline" | "fullscreen") => Promise<boolean>>()
      .mockResolvedValue(true);
    const f = fixture();
    const frame = f.frame;
    const bridge = createPackagedUiBridge({
      frame,
      nonce: "nonce-2",
      host: () => f.host,
      onReady: vi.fn<() => void>(),
      onError: vi.fn<(message: string) => void>(),
      displayMode: () => "fullscreen",
      onDisplayModeRequest,
    });
    const send = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", { source: frame.contentWindow, origin: "null", data }),
      );
    send({ marshalSandbox: "nonce-2" });
    send({ jsonrpc: "2.0", id: "init", method: "ui/initialize", params: {} });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "init",
          result: expect.objectContaining({
            hostContext: expect.objectContaining({
              displayMode: "fullscreen",
              availableDisplayModes: expect.arrayContaining(["inline", "fullscreen"]),
            }),
          }),
        }),
        "*",
      ),
    );
    send({
      jsonrpc: "2.0",
      id: "mode",
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "mode",
          result: { requested: "fullscreen", actual: "fullscreen", status: "accepted" },
        }),
        "*",
      ),
    );
    expect(onDisplayModeRequest).toHaveBeenCalledWith("fullscreen");
    bridge.dispose();
    f.dispose();
  });

  it("stays unsupported without an embedder handler and reports content height", async () => {
    const heights: number[] = [];
    const f = fixture();
    const frame = f.frame;
    const bridge = createPackagedUiBridge({
      frame,
      nonce: "nonce-3",
      host: () => f.host,
      onReady: vi.fn<() => void>(),
      onError: vi.fn<(message: string) => void>(),
      onContentHeight: (height) => heights.push(height),
    });
    const send = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", { source: frame.contentWindow, origin: "null", data }),
      );
    send({ marshalSandbox: "nonce-3" });
    send({ jsonrpc: "2.0", id: "init", method: "ui/initialize", params: {} });
    send({
      jsonrpc: "2.0",
      id: "mode",
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "mode",
          result: expect.objectContaining({ status: "unsupported" }),
        }),
        "*",
      ),
    );
    send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 412.4 } });
    await vi.waitFor(() => expect(heights).toContain(412.4));
    bridge.dispose();
    f.dispose();
  });
});

describe("authored component viewport gate", () => {
  // The wrapper carries the runtime-stamped responsive viewport meta; it must
  // never count as a declaration.
  const componentDoc =
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="marshal-props" content=""><title>t</title></head>' +
    '<body><main id="root"></main><script>render()</script></body></html>';

  function authoredViewportFixture(
    bridgeOptions: Partial<Parameters<typeof createPackagedUiBridge>[0]>,
  ) {
    return fixture(
      {
        instance: {
          instanceId: "instance",
          owner: {
            sessionId: "session",
            workspaceName: "workspace",
            extensionId: "marshal.react-ui",
            applicationId: "sample",
          },
          surface: "tab",
          revision: 1,
          openedAt: "now",
          focusedAt: "now",
          updatedAt: "now",
          idempotencyKey: "open",
          content: {
            kind: "application",
            renderId: "sample",
            resource: {
              uri: "ui://marshal-react/runtime-renderer/1/index.html",
              mimeType: "text/html",
            },
            descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
          },
        },
      },
      bridgeOptions,
    );
  }

  function requestPayload(
    f: ReturnType<typeof fixture>,
    viewports?: readonly string[],
    props?: Record<string, unknown>,
  ) {
    f.initialize();
    f.invoke.mockResolvedValueOnce({
      output: {
        content: [],
        structuredContent: {
          ...(props ? { props } : {}),
          marshal: {
            kind: "compiled_react_ui",
            componentHtml: componentDoc,
            componentId: "c1",
            ...(viewports ? { viewports } : {}),
          },
        },
      },
    });
    f.send({
      jsonrpc: "2.0",
      id: "payload",
      method: "tools/call",
      params: { name: "marshal_get_react_payload", arguments: { renderId: "sample" } },
    });
  }

  it("replaces an undeclared authored component with an inert notice on the mobile client", async () => {
    const missing = vi.fn<(viewport: "mobile" | "desktop") => void>();
    const f = authoredViewportFixture({
      viewport: () => "mobile",
      onViewportVariantMissing: missing,
    });
    requestPayload(f);
    await vi.waitFor(() => {
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "payload",
          result: expect.objectContaining({
            structuredContent: expect.objectContaining({
              marshal: expect.objectContaining({
                componentHtml: expect.stringContaining("no mobile view"),
              }),
            }),
          }),
        }),
        "*",
      );
    });
    // The desktop-only script must not reach the phone's nested mount.
    expect(f.post).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: "payload",
        result: expect.objectContaining({
          structuredContent: expect.objectContaining({
            marshal: expect.objectContaining({
              componentHtml: expect.stringContaining("render()"),
            }),
          }),
        }),
      }),
      "*",
    );
    expect(missing).toHaveBeenCalledWith("mobile");
    f.dispose();
  });

  it("mounts declared-mobile authored components and reports nothing missing", async () => {
    const missing = vi.fn<(viewport: "mobile" | "desktop") => void>();
    const f = authoredViewportFixture({
      viewport: () => "mobile",
      onViewportVariantMissing: missing,
    });
    requestPayload(f, ["mobile", "desktop"]);
    await vi.waitFor(() => {
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "payload",
          result: expect.objectContaining({
            structuredContent: expect.objectContaining({
              marshal: expect.objectContaining({
                componentHtml: expect.stringContaining("application/x-marshal-bundle"),
              }),
            }),
          }),
        }),
        "*",
      );
    });
    expect(missing).not.toHaveBeenCalled();
    f.dispose();
  });

  it("keeps the desktop default for undeclared authored components on desktop", async () => {
    const missing = vi.fn<(viewport: "mobile" | "desktop") => void>();
    const f = authoredViewportFixture({
      viewport: () => "desktop",
      onViewportVariantMissing: missing,
    });
    requestPayload(f);
    await vi.waitFor(() => {
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "payload",
          result: expect.objectContaining({
            structuredContent: expect.objectContaining({
              marshal: expect.objectContaining({
                componentHtml: expect.stringContaining("application/x-marshal-bundle"),
              }),
            }),
          }),
        }),
        "*",
      );
    });
    expect(missing).not.toHaveBeenCalled();
    f.dispose();
  });
  it("stamps the host theme tokens onto the authored component document", async () => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.setProperty("--foreground", "hsl(240, 14%, 92%)");
    try {
      const f = authoredViewportFixture({ viewport: () => "desktop" });
      requestPayload(f);
      await vi.waitFor(() => {
        expect(f.post).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "payload",
            result: expect.objectContaining({
              structuredContent: expect.objectContaining({
                marshal: expect.objectContaining({
                  componentHtml: expect.stringContaining(
                    "color-scheme:dark;--color-text-primary:hsl(240, 14%, 92%)",
                  ),
                }),
              }),
            }),
          }),
          "*",
        );
      });
      f.dispose();
    } finally {
      delete document.documentElement.dataset.theme;
      document.documentElement.style.removeProperty("--foreground");
    }
  });

  it("gates an authored render on the viewports declared in its reserved render prop", async () => {
    const missing = vi.fn<(viewport: "mobile" | "desktop") => void>();
    const f = authoredViewportFixture({
      viewport: () => "desktop",
      onViewportVariantMissing: missing,
    });
    requestPayload(f, undefined, { marshalViewports: ["mobile"] });
    await vi.waitFor(() => expect(missing).toHaveBeenCalledWith("desktop"));
    f.dispose();
  });

  it("tells a declared authored render which client is viewing it", async () => {
    const f = authoredViewportFixture({ viewport: () => "mobile" });
    requestPayload(f, undefined, { marshalViewports: ["mobile", "desktop"], rows: 3 });
    await vi.waitFor(() => {
      expect(f.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "payload",
          result: expect.objectContaining({
            structuredContent: expect.objectContaining({
              props: {
                marshalViewports: ["mobile", "desktop"],
                rows: 3,
                marshalViewport: "mobile",
              },
            }),
          }),
        }),
        "*",
      );
    });
    f.dispose();
  });
});
