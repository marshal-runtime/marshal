/**
 * DesktopCapabilities WS bridge.
 *
 * Maps each `IDesktopCapabilities` method onto an inbound RPC handler under
 * the method name `desktop.<rpc>` on the gateway WS client. The cloud-side
 * (marshal) sends `{ type: "req", method: "desktop.executeLocalTool", ... }`
 * and we route to the matching handler, then ship the return value back as
 * a `res` over the same socket.
 *
 * Each registration:
 *   1. Wraps the handler with try/catch, then re-throws errors so the WS client's
 *      `handleInboundRequest` catches them and sends a `not-ok` envelope back
 *      (which conforms to the `DesktopCapabilityError` wire shape).
 *   2. Tracks an unregister function so `detach()` is clean.
 *
 * Spec: docs/specs/gateway-automations-phase-2b-design.md §5.1, §5.4.
 */

import { createLogger } from "../../../../common/marshal-logger";
import { type DesktopCapabilities } from "../../types";

const log = createLogger("DesktopCapabilitiesBridge");

/** Subset of the GatewayWsClient surface this bridge actually uses. */
export interface DesktopBridgeWsClient {
  registerInboundHandler(
    method: string,
    handler: (params: Record<string, unknown>) => Promise<unknown>,
  ): () => void;
}

// 2 RPCs: `evaluateLocalPolicy` and `showApprovalCard` moved to
// `GatewayToolBackend.attachApprovalRouter` and register on the WS client
// directly (not through this bridge). See `desktop-capabilities.ts`.
const RPC_METHODS = ["executeLocalTool", "showNotification"] as const;
type RpcMethod = (typeof RPC_METHODS)[number];

function makeMethodName(rpc: RpcMethod): string {
  return `desktop.${rpc}`;
}

export class DesktopCapabilitiesBridge {
  private unregisters: Array<() => void> = [];
  private readonly capabilities: DesktopCapabilities;

  constructor(capabilities: DesktopCapabilities) {
    this.capabilities = capabilities;
  }

  /**
   * Register the bridge's `desktop.*` methods on the WS client. Idempotent —
   * a second `attach` call detaches first so we never have stale duplicates
   * against the same WS instance (which would throw on the second
   * `registerInboundHandler` for the same method).
   */
  attach(wsClient: DesktopBridgeWsClient): void {
    if (this.unregisters.length > 0) {
      this.detach();
    }

    for (const rpc of RPC_METHODS) {
      const methodName = makeMethodName(rpc);
      const wrapped = this.wrapHandler(rpc);
      const unregister = wsClient.registerInboundHandler(methodName, wrapped);
      this.unregisters.push(unregister);
    }

    log.info(`attached ${RPC_METHODS.length} desktop.* RPC handlers`);
  }

  detach(): void {
    for (const unreg of this.unregisters) unreg();
    this.unregisters = [];
    log.info("detached desktop.* RPC handlers");
  }

  /**
   * Build the per-RPC closure: invoke the matching capability method and
   * re-throw errors so the WS client's inbound-RPC machinery converts them
   * into the wire envelope.
   */
  private wrapHandler(rpc: RpcMethod): (params: Record<string, unknown>) => Promise<unknown> {
    // Bind once to the capabilities instance — handlers may rely on `this`
    // through their closure (the make<X>Handler factories don't, but binding
    // is the safe default and removes a "did you forget to bind?" footgun).
    const handler = this.capabilities[rpc].bind(this.capabilities);

    return async (params) => {
      // Each handler validates its own params shape — we widen to `never`
      // here so TS accepts the call across the union of parameter types.
      // The runtime payload comes off the wire as a JSON object; per-RPC
      // schemas are checked inside the handler factories.
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- per-RPC param schemas validated inside the handler factories; bridge widens to common Record<string, unknown> for dispatch
      const result = await handler(params as never);
      // Wrap return value so the WS client always sees a Record<string, unknown>
      // payload. Handlers may return `void` (showNotification), an object
      // (most), or — defensively — a primitive; we hoist primitives under a
      // `result` key. The WS client itself widens `payload` to `unknown`,
      // but normalizing here keeps the wire shape consistent.
      if (result === undefined) return {};
      if (typeof result === "object" && result !== null) return result;
      return { result };
    };
  }
}
