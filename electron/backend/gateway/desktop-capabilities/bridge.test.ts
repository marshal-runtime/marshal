import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../../testing/harness/test-double";
import { DesktopCapabilityErrorThrow, type DesktopCapabilities } from "../../types";
import { DesktopCapabilitiesBridge, type DesktopBridgeWsClient } from "./bridge";

interface RegisteredHandler {
  method: string;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  unregister: ReturnType<typeof vi.fn<() => void>>;
}

function makeFakeClient(): {
  client: DesktopBridgeWsClient;
  registered: RegisteredHandler[];
} {
  const registered: RegisteredHandler[] = [];
  const client: DesktopBridgeWsClient = {
    registerInboundHandler: (method, handler) => {
      const unregister = vi.fn<() => void>();
      registered.push({ method, handler, unregister });
      return unregister;
    },
  };
  return { client, registered };
}

function makeCapabilities(overrides: Partial<DesktopCapabilities> = {}): DesktopCapabilities {
  return testDouble<DesktopCapabilities>({
    executeLocalTool: vi
      .fn<DesktopCapabilities["executeLocalTool"]>()
      .mockResolvedValue({ output: { ok: true }, success: true }),
    showNotification: vi.fn<DesktopCapabilities["showNotification"]>().mockResolvedValue(undefined),
    ...overrides,
  });
}

describe("DesktopCapabilitiesBridge", () => {
  // 2 RPCs flow through this bridge. The `evaluateLocalPolicy` /
  // `showApprovalCard` pair is registered by `GatewayToolBackend.attachApprovalRouter`
  // directly on the WS client — see backend.ts and the gateway-backend tests.
  const expectedMethods = ["desktop.executeLocalTool", "desktop.showNotification"];

  it("attach registers all 2 desktop.* RPC method names", () => {
    const { client, registered } = makeFakeClient();
    const bridge = new DesktopCapabilitiesBridge(makeCapabilities());

    bridge.attach(client);

    expect(registered.map((r) => r.method).sort()).toEqual([...expectedMethods].sort());
  });

  it("detach calls every unregister returned by registerInboundHandler", () => {
    const { client, registered } = makeFakeClient();
    const bridge = new DesktopCapabilitiesBridge(makeCapabilities());

    bridge.attach(client);
    bridge.detach();

    expect(registered).toHaveLength(2);
    for (const r of registered) {
      expect(r.unregister).toHaveBeenCalledOnce();
    }
  });

  it("re-attach is idempotent: detaches old before re-registering", () => {
    const { client, registered } = makeFakeClient();
    const bridge = new DesktopCapabilitiesBridge(makeCapabilities());

    bridge.attach(client);
    bridge.attach(client); // should detach first

    // Old unregisters fired exactly once.
    const firstTwo = registered.slice(0, 2);
    for (const r of firstTwo) {
      expect(r.unregister).toHaveBeenCalledOnce();
    }
    // 2 fresh registrations followed.
    expect(registered).toHaveLength(4);
  });

  it("on success, returns the handler's result", async () => {
    const { client, registered } = makeFakeClient();
    const bridge = new DesktopCapabilitiesBridge(makeCapabilities());
    bridge.attach(client);

    const entry = registered.find((r) => r.method === "desktop.executeLocalTool");
    expect(entry).toBeDefined();
    const result = await entry!.handler({
      kind: "shell",
      toolName: "shell",
      sessionId: "s-1",
    });

    expect(result).toEqual({ output: { ok: true }, success: true });
  });

  it("wraps a void return (showNotification) as {} for the wire", async () => {
    const { client, registered } = makeFakeClient();
    const bridge = new DesktopCapabilitiesBridge(makeCapabilities());
    bridge.attach(client);

    const entry = registered.find((r) => r.method === "desktop.showNotification");
    expect(entry).toBeDefined();
    const result = await entry!.handler({ title: "Hi", body: "Body" });

    expect(result).toEqual({});
  });

  it("on thrown error, re-throws so the WS layer envelope-encodes it", async () => {
    const { client, registered } = makeFakeClient();
    const caps = makeCapabilities({
      executeLocalTool: vi
        .fn<DesktopCapabilities["executeLocalTool"]>()
        .mockRejectedValue(new Error("policy-deny: forbidden")),
    });
    const bridge = new DesktopCapabilitiesBridge(caps);
    bridge.attach(client);

    const entry = registered.find((r) => r.method === "desktop.executeLocalTool");
    expect(entry).toBeDefined();
    await expect(
      entry!.handler({ kind: "shell", toolName: "shell", sessionId: "s-1" }),
    ).rejects.toThrow(/policy-deny/);
  });

  it("re-throws plain and object errors without crashing", async () => {
    const { client, registered } = makeFakeClient();
    const caps = makeCapabilities({
      showNotification: vi
        .fn<DesktopCapabilities["showNotification"]>()
        .mockImplementation(async () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw "plain string failure";
        }),
    });
    const bridge = new DesktopCapabilitiesBridge(caps);
    bridge.attach(client);

    const entry = registered.find((r) => r.method === "desktop.showNotification");
    await expect(entry!.handler({ title: "Hi", body: "Body" })).rejects.toBe(
      "plain string failure",
    );

    const caps2 = makeCapabilities({
      showNotification: vi
        .fn<DesktopCapabilities["showNotification"]>()
        .mockImplementation(async () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw { failure: true };
        }),
    });
    const bridge2 = new DesktopCapabilitiesBridge(caps2);
    const { client: client2, registered: registered2 } = makeFakeClient();
    bridge2.attach(client2);
    const entry2 = registered2.find((r) => r.method === "desktop.showNotification");
    await expect(entry2!.handler({ title: "Hi", body: "Body" })).rejects.toEqual({
      failure: true,
    });
  });

  it("re-throws DesktopCapabilityErrorThrow as-is so ws-client can read .code", async () => {
    // The ws-client's handleInboundRequest reads `error.code` to populate the
    // wire response envelope. The bridge must NOT wrap or replace structured
    // throws.
    const { client, registered } = makeFakeClient();
    const structured = new DesktopCapabilityErrorThrow("policy-deny", "Local policy denied");
    const caps = makeCapabilities({
      executeLocalTool: vi
        .fn<DesktopCapabilities["executeLocalTool"]>()
        .mockRejectedValue(structured),
    });
    const bridge = new DesktopCapabilitiesBridge(caps);
    bridge.attach(client);

    const entry = registered.find((r) => r.method === "desktop.executeLocalTool");
    let caught: unknown;
    try {
      await entry!.handler({ kind: "shell", toolName: "shell", sessionId: "s-1" });
    } catch (err) {
      caught = err;
    }

    // Bridge re-throws the same instance — ws-client.handleInboundRequest
    // reads .code off it for the wire response.
    expect(caught).toBe(structured);
    if (!(caught instanceof DesktopCapabilityErrorThrow)) {
      throw new Error("expected DesktopCapabilityErrorThrow");
    }
    expect(caught.code).toBe("policy-deny");
  });

  it("wraps a primitive return under { result } on the wire", async () => {
    const { client, registered } = makeFakeClient();
    const caps = makeCapabilities({
      // Force a primitive return through the type assertion. The real handler
      // signatures don't return primitives — this tests the bridge's defensive
      // hoist for any future RPC whose payload is a number/string.
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- exercising bridge defensive primitive hoist
      executeLocalTool: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(42) as unknown as DesktopCapabilities["executeLocalTool"],
    });
    const bridge = new DesktopCapabilitiesBridge(caps);
    bridge.attach(client);

    const entry = registered.find((r) => r.method === "desktop.executeLocalTool");
    const result = await entry!.handler({ kind: "shell", toolName: "shell", sessionId: "s-1" });

    expect(result).toEqual({ result: 42 });
  });
});
