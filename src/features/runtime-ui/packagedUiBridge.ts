import type {
  RuntimeUiEvent,
  RuntimeUiInstance,
  RuntimeUiSelectedSession,
  RuntimeUiImageHandle,
} from "@common/runtime-ui";
import type { MarshalUiViewport } from "@common/runtime-ui-viewports";
import type { UiHostContext, UiProtocolMessage } from "@marshal/runtime/ui";

import { sandboxAuthoredComponentHtml } from "./authoredComponentDocument";
import { reconcileCachedComponent, withCachedComponent } from "./authoredPayloadCache";
import { MediaInteraction } from "./mediaInteraction";
import { openApplicationLink } from "./openApplicationLink";
import type { RuntimeUiApplicationRenderHost } from "./RuntimeUiApplicationRegistry";
import { parseHostChromeHint } from "./runtimeUiFrameChrome";
import { workspaceInteraction } from "./workspaceInteraction";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_PENDING_REQUESTS = 32;
const MAX_SESSION_ID = 256;

/**
 * OMR2-1: both denial messages come verbatim from SelectedSessionDeliveryService
 * (electron/marshal-runtime/selected-session-delivery.ts) — the only authority
 * that refuses work for a missing/stale session grant. When one surfaces, the
 * user has to perform a fresh visible picker selection (§7), so the host
 * summons the picker instead of leaving the app stuck behind a dead strip.
 */
function isSessionGrantRequired(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /native host picker/i.test(error.message) ||
    /selected session.*select it again/i.test(error.message) ||
    /select an execution session/i.test(error.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object.");
  return value;
}

function boundedMessage(value: unknown): UiProtocolMessage | undefined {
  try {
    const message = record(value);
    if (
      new TextEncoder().encode(JSON.stringify(message)).length > MAX_MESSAGE_BYTES ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string"
    )
      return undefined;
    if (
      message.id !== undefined &&
      typeof message.id !== "string" &&
      typeof message.id !== "number"
    )
      return undefined;
    return { jsonrpc: "2.0", id: message.id, method: message.method, params: message.params };
  } catch {
    return undefined;
  }
}

export function packagedUiHostContext(
  instance: RuntimeUiInstance,
  selectedSession?: RuntimeUiSelectedSession | null,
  selectedImages?: readonly RuntimeUiImageHandle[],
  displayModeOverride?: "inline" | "fullscreen",
): UiHostContext & { readonly formFactor: MarshalUiViewport } {
  const surfaceMode =
    instance.surface === "fullscreen"
      ? "fullscreen"
      : instance.surface === "panel"
        ? "pip"
        : "inline";
  const displayMode = displayModeOverride ?? surfaceMode;
  // Every embedding can expand to the host's fullscreen overlay and return;
  // the native fullscreen surface is already terminal.
  const availableDisplayModes =
    surfaceMode === "fullscreen"
      ? (["fullscreen"] as const)
      : ([...new Set([surfaceMode, "inline", "fullscreen"] as const)] as (
          | "inline"
          | "fullscreen"
          | "pip"
        )[]);
  return {
    displayMode,
    // The viewing client's form factor, surfaced through the SAME host-context
    // channel the app already reads (initialize + host-context-changed) — the
    // one truth for sandboxed UIs on both surfaces.
    formFactor: window.marshalRemote ? "mobile" : "desktop",
    selectedSession: selectedSession ?? null,
    selectedImages: selectedImages ?? [],
    availableDisplayModes,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    styles: {
      variables: {
        "--color-background-primary": getComputedStyle(document.documentElement).getPropertyValue(
          "--background",
        ),
        "--color-text-primary": getComputedStyle(document.documentElement).getPropertyValue(
          "--foreground",
        ),
      },
    },
  };
}

export function createPackagedUiBridge(options: {
  readonly frame: HTMLIFrameElement;
  readonly nonce: string;
  readonly host: () => RuntimeUiApplicationRenderHost;
  readonly onReady: () => void;
  readonly onError: (message: string) => void;
  /** Current embedder display mode when it differs from the surface default. */
  readonly displayMode?: () => "inline" | "fullscreen" | undefined;
  /** Embedder-implemented display-mode switch; resolves true once applied. */
  readonly onDisplayModeRequest?: (mode: "inline" | "fullscreen") => boolean | Promise<boolean>;
  /** Content-height reports from the application, for natural-height embeds. */
  readonly onContentHeight?: (height: number) => void;
  /** Escape pressed inside the (nested) sandboxed documents. */
  readonly onEscape?: () => void;
  /** Viewing client's viewport for the authored-component gate; defaults to
   *  the window's own client (remote/mobile vs desktop). */
  readonly viewport?: () => MarshalUiViewport;
  /** An authored component declared no variant for this client's viewport. */
  readonly onViewportVariantMissing?: (viewport: MarshalUiViewport) => void;
  /** OMR2-2: the app's `ui/initialize` hostChrome opt-in, if it sent one. */
  readonly onChromeHint?: (chrome: "compact" | "hidden") => void;
}) {
  let active = true;
  let authenticated = false;
  let initialized = false;
  // Nonces of nested component documents this bridge itself sandboxed; their
  // bootstrap uses the nonce as a capability token for the Escape relay.
  const childNonces = new Set<string>();
  const pending = new Map<string | number, { readonly idempotencyKey: string }>();
  const send = (message: UiProtocolMessage) => {
    if (!active) return;
    try {
      if (new TextEncoder().encode(JSON.stringify(message)).length > 8 * MAX_MESSAGE_BYTES) {
        if (message.id !== undefined)
          // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- the allow-scripts-only sandboxed frame has an opaque origin, so no specific targetOrigin can be named
          options.frame.contentWindow?.postMessage(
            {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32000, message: "Application response exceeds 8 MiB." },
            },
            "*",
          );
        return;
      }
      // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- the allow-scripts-only sandboxed frame has an opaque origin, so no specific targetOrigin can be named
      options.frame.contentWindow?.postMessage(message, "*");
    } catch {
      if (message.id !== undefined)
        // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- the allow-scripts-only sandboxed frame has an opaque origin, so no specific targetOrigin can be named
        options.frame.contentWindow?.postMessage(
          {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "Application response could not be serialized." },
          },
          "*",
        );
    }
  };
  const notify = (method: string, params: unknown) => send({ jsonrpc: "2.0", method, params });
  const declaredFeatures = () => {
    const content = options.host().instance.content;
    return content.kind === "application" ? (content.descriptor.hostFeatures ?? []) : [];
  };
  const workspaceScope = () => {
    const host = options.host();
    const sessionId = host.selectedSession?.sessionId ?? host.instance.owner.sessionId;
    if (!sessionId) throw new Error("Select an execution session to use workspace interaction.");
    return {
      workspaceName: host.selectedSession?.workspaceName ?? host.instance.owner.workspaceName,
      sessionId,
    };
  };
  const media = new MediaInteraction(
    options.host().instance.owner.applicationId,
    (event) => notify("ui/notifications/interaction", event),
    () => options.frame.closest("dialog") ?? document.body,
  );
  const authorityKey = () =>
    JSON.stringify([
      options.host().instance.owner,
      options.host().selectedSession?.grantId,
      declaredFeatures(),
    ]);
  let lastAuthority = authorityKey();
  const unsubscribeWorkspace = workspaceInteraction.subscribe(() => {
    if (!initialized || !declaredFeatures().includes("workspace")) return;
    try {
      notify("ui/notifications/interaction", {
        type: "workspace",
        snapshot: workspaceInteraction.snapshot(workspaceScope()),
      });
    } catch {
      /* No selected session. */
    }
  });
  const dispatch = async (message: UiProtocolMessage, idempotencyKey: string): Promise<unknown> => {
    const host = options.host();
    const content = host.instance.content;
    if (content.kind !== "application") throw new Error("Application is unavailable.");
    const params = record(message.params ?? {});
    switch (message.method) {
      case "ui/initialize": {
        initialized = true;
        const chrome = parseHostChromeHint(params.hostChrome);
        if (chrome) options.onChromeHint?.(chrome);
        options.onReady();
        return {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "Marshal", version: "1.0.0" },
          hostCapabilities: {
            serverTools: true,
            serverResources: true,
            interaction: { version: 1, features: declaredFeatures() },
          },
          hostContext: packagedUiHostContext(
            host.instance,
            host.selectedSession,
            host.selectedImages,
            options.displayMode?.(),
          ),
        };
      }
      case "marshal/interaction": {
        if (!initialized || typeof params.operation !== "string")
          throw new Error("Initialize before interacting with the host.");
        const feature = params.operation.split(".")[0];
        if (
          (feature !== "workspace" && feature !== "media") ||
          !declaredFeatures().includes(feature)
        )
          throw new Error("Application has not declared this host feature.");
        if (host.instance.owner.applicationScope && params.operation !== "media.close") {
          const selected = await host.getSelectedSession?.();
          if (!selected || selected.grantId !== host.selectedSession?.grantId)
            throw new Error("Select an execution session in the native host picker.");
        }
        switch (params.operation) {
          case "workspace.snapshot":
            return workspaceInteraction.snapshot(workspaceScope());
          case "workspace.read":
            return workspaceInteraction.read(
              workspaceScope(),
              params.documentId,
              params.expectedVersion,
            );
          case "workspace.reveal":
            return workspaceInteraction.reveal(
              workspaceScope(),
              params.documentId,
              params.expectedVersion,
              params.range,
              params.focus === true,
            );
          case "workspace.annotate":
            return workspaceInteraction.annotate(
              options.nonce,
              workspaceScope(),
              params.documentId,
              params.expectedVersion,
              params.annotations,
            );
          case "media.offer":
            return media.offer();
          case "media.answer":
            return media.answer(params.connectionId, params.sdp);
          case "media.send":
            return media.send(params.connectionId, params.event);
          case "media.close":
            return media.close(params.connectionId);
          default:
            throw new Error("Unsupported interaction operation.");
        }
      }
      case "tools/call": {
        if (!initialized) throw new Error("Initialize the application before invoking tools.");
        const args = record(params.arguments ?? {});
        const portableTool = params.name === "marshal_invoke_react_tool";
        const tool = portableTool
          ? content.descriptor.tools.find((entry) => entry.id === args.toolId)
          : content.descriptor.tools.find((entry) => entry.name === params.name);
        const action = content.descriptor.actions.find(
          (entry) => entry.target.kind === "capability" && entry.target.capability === params.name,
        );
        // Authored-render bootstrap: the renderer template's render-plane
        // calls (payload fetch, declared-action/tool dispatch, local-state
        // sync) are implicitly permitted for the instance's OWN render id even
        // when the projected manifest declares no tools. The runtime's
        // render-tool dispatcher enforces the render's declared actions/tools
        // and their scopes, and the render-identity check here (plus host-side
        // re-binding) pins every call to this application.
        const authoredPayloadTool =
          content.kind === "application" &&
          // Reserved authored owner only (public contract value of
          // REACT_UI_PUBLICATION_OWNER_ID); extension-published applications
          // never receive implicit render-plane routing — their capabilities
          // stay pinned to the publication's declared set.
          host.instance.owner.extensionId === "marshal.react-ui" &&
          (params.name === "marshal_get_react_payload" ||
            params.name === "marshal_invoke_react_action" ||
            params.name === "marshal_invoke_react_tool" ||
            params.name === "marshal_update_react_state" ||
            params.name === `marshal_render_react_${content.renderId}`) &&
          (args.renderId === undefined || args.renderId === content.renderId);
        const capability =
          tool?.name ??
          (action?.target.kind === "capability" ? action.target.capability : undefined) ??
          (authoredPayloadTool && typeof params.name === "string" ? params.name : undefined);
        if (!capability) throw new Error("The application has not declared this capability.");
        if (portableTool && args.renderId !== content.renderId)
          throw new Error("Render identity does not match this application.");
        const cachedPayload =
          authoredPayloadTool &&
          content.kind === "application" &&
          params.name === "marshal_get_react_payload"
            ? { renderId: content.renderId, ...withCachedComponent(content.renderId, args) }
            : undefined;
        let result;
        try {
          result = await host.invokeCapability({
            capability,
            input: portableTool ? args.input : (cachedPayload?.input ?? args),
            idempotencyKey:
              typeof params._meta === "object" &&
              params._meta !== null &&
              typeof record(params._meta).idempotencyKey === "string"
                ? String(record(params._meta).idempotencyKey)
                : idempotencyKey,
          });
        } catch (error) {
          if (isSessionGrantRequired(error)) host.requestSessionPicker?.();
          throw error;
        }
        // The payload lookup is itself a render-tool call, so its output IS the
        // MCP tool result the renderer template validates (content/structured
        // content/_meta) — return it unwrapped instead of the capability
        // envelope, which the template cannot introspect.
        if (authoredPayloadTool && !tool && !action && isRecord(result.output)) {
          return sandboxAuthoredComponentHtml(
            cachedPayload
              ? reconcileCachedComponent(
                  cachedPayload.renderId,
                  result.output,
                  cachedPayload.fromCache,
                )
              : result.output,
            (childNonce) => childNonces.add(childNonce),
            {
              viewport: options.viewport?.() ?? (window.marshalRemote ? "mobile" : "desktop"),
              onMissing: options.onViewportVariantMissing,
            },
          );
        }
        return {
          content: [],
          structuredContent: portableTool
            ? { status: "success", output: result.output }
            : { output: result.output },
        };
      }
      case "resources/read": {
        if (!initialized || typeof params.uri !== "string")
          throw new Error("A resource URI is required after initialization.");
        const imageHandle = /^marshal-ui-image:\/\/([A-Za-z0-9_-]{1,256})$/.exec(params.uri)?.[1];
        if (imageHandle) {
          if (
            !host.readImage ||
            !host.selectedImages?.some((image) => image.handle === imageHandle)
          )
            throw new Error("This image was not selected for the application.");
          const image = await host.readImage(imageHandle);
          return { contents: [{ uri: params.uri, mimeType: image.mimeType, blob: image.data }] };
        }
        return { contents: [await host.readResource(params.uri)] };
      }
      case "ui/request-display-mode": {
        const requestedMode = params.mode;
        if (
          (requestedMode === "fullscreen" || requestedMode === "inline") &&
          options.onDisplayModeRequest &&
          (await options.onDisplayModeRequest(requestedMode))
        ) {
          return { requested: requestedMode, actual: requestedMode, status: "accepted" };
        }
        return {
          requested: params.mode,
          actual: packagedUiHostContext(
            host.instance,
            host.selectedSession,
            host.selectedImages,
            options.displayMode?.(),
          ).displayMode,
          status: "unsupported",
          reason: "Use Marshal's application controls to change the display mode.",
        };
      }
      case "ui/searchSessions": {
        if (!initialized) throw new Error("Initialize the application before searching sessions.");
        if (!host.searchSessions) throw new Error("Session search is unavailable in this host.");
        const query = typeof params.query === "string" ? params.query : "";
        const limit = typeof params.limit === "number" ? params.limit : undefined;
        return { sessions: await host.searchSessions(query, limit) };
      }
      case "ui/selectSession": {
        if (!initialized) throw new Error("Initialize the application before selecting a session.");
        host.requestSessionPicker?.();
        throw new Error("Select an execution session using the native host picker.");
      }
      case "ui/requestSessionSelection": {
        if (!initialized)
          throw new Error("Initialize the application before requesting a session selection.");
        // §7: this only makes the native picker visible. The grant itself is
        // minted exclusively by the user's selection inside that picker.
        if (!host.requestSessionPicker)
          throw new Error("The native session picker is unavailable in this host.");
        host.requestSessionPicker();
        return { status: "requested" };
      }
      case "ui/getSelectedSession": {
        if (!initialized)
          throw new Error("Initialize the application before reading session state.");
        if (!host.getSelectedSession)
          throw new Error("Selected session state is unavailable in this host.");
        return host.getSelectedSession();
      }
      case "ui/openSession": {
        if (!initialized) throw new Error("Initialize the application before opening a session.");
        if (!host.openSession) throw new Error("Opening a session is unavailable in this host.");
        const sessionId = params.sessionId;
        if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > MAX_SESSION_ID)
          throw new Error("A session ID is required.");
        try {
          await host.openSession(sessionId);
        } catch {
          throw new Error("The session could not be opened.");
        }
        return {};
      }
      case "ui/open-link":
        return openApplicationLink(params.url);
      default:
        throw new Error("This application host method is unavailable.");
    }
  };
  const receive = (event: MessageEvent) => {
    if (!active) return;
    // Escape relay: sandbox bootstraps post their nonce to window.top on
    // Escape. Keydown never crosses browsing contexts, so this is the only
    // signal the host gets while focus sits inside a nested app document. The
    // nonce doubles as the capability token (only documents this bridge
    // sandboxed hold one).
    if (
      event.origin === "null" &&
      typeof event.data === "object" &&
      event.data !== null &&
      typeof event.data.marshalSandboxEscape === "string" &&
      (event.data.marshalSandboxEscape === options.nonce ||
        childNonces.has(event.data.marshalSandboxEscape))
    ) {
      options.onEscape?.();
      return;
    }
    if (event.source !== options.frame.contentWindow || event.origin !== "null") return;
    if (typeof event.data === "object" && event.data?.marshalSandbox === options.nonce) {
      authenticated = true;
      return;
    }
    if (!authenticated) return;
    if (typeof event.data === "object" && event.data?.marshalSandboxError === options.nonce) {
      options.onError(
        "The application script failed. Correct its bundle and reload the application.",
      );
      return;
    }
    const message = boundedMessage(event.data);
    if (!message) return;
    if (message.method === "ui/notifications/size-changed") {
      const height = Number(record(message.params ?? {}).height);
      if (Number.isFinite(height) && height > 0) options.onContentHeight?.(height);
      return;
    }
    if (message.method === "ui/notifications/initialized") {
      notify("ui/notifications/tool-input", {
        arguments:
          options.host().instance.content.kind === "application"
            ? options.host().instance.content
            : {},
      });
      return;
    }
    if (message.method === "notifications/cancelled") {
      try {
        const id = record(message.params).requestId;
        if (typeof id === "string" || typeof id === "number") {
          const request = pending.get(id);
          pending.delete(id);
          if (request)
            void options
              .host()
              .cancelCapability?.(request.idempotencyKey)
              .catch(() => undefined);
        }
      } catch {
        /* Malformed cancellation does not affect other requests. */
      }
      return;
    }
    if (message.id === undefined) return;
    const { id } = message;
    if (pending.has(id)) return;
    if (pending.size >= MAX_PENDING_REQUESTS) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "Too many application requests are pending." },
      });
      return;
    }
    const params = isRecord(message.params) ? message.params : {};
    const meta = isRecord(params._meta) ? params._meta : {};
    const request = {
      idempotencyKey:
        typeof meta.idempotencyKey === "string"
          ? meta.idempotencyKey
          : `packaged-ui:${options.nonce}:${String(id)}`,
    };
    pending.set(id, request);
    void dispatch(message, request.idempotencyKey)
      .then(
        (result) => {
          if (pending.get(id) === request) send({ jsonrpc: "2.0", id, result });
        },
        (error: unknown) => {
          if (pending.get(id) === request)
            send({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : "Application operation failed.",
                ...(isRecord(error) && typeof error.code === "string"
                  ? { data: { code: error.code } }
                  : {}),
              },
            });
        },
      )
      .finally(() => {
        if (pending.get(id) === request) pending.delete(id);
      });
  };
  window.addEventListener("message", receive);
  const timeout = window.setTimeout(() => {
    if (!initialized && active)
      options.onError(
        "The application did not initialize. Check its packaged script and try again.",
      );
  }, 10_000);
  const unsubscribe = options.host().subscribe((event: RuntimeUiEvent) => {
    if (!initialized) return;
    // CF-05 live progressive-answer push: forward a session delivery's stream
    // chunks ONLY into the OWNING application's frame. The main process has
    // already scope-filtered the event to this window (isVisibleToScope);
    // this owner check completes the guard so a co-resident application of a
    // different extension (or a different application of the same extension)
    // never observes another owner's stream.
    if (event.type === "delivery-stream") {
      const owner = options.host().instance.owner;
      if (
        event.owner.extensionId === owner.extensionId &&
        event.owner.applicationId === owner.applicationId
      )
        notify("ui/notifications/delivery-stream", {
          requestId: event.requestId,
          streamSequence: event.streamSequence,
          chunk: event.chunk,
          terminal: event.terminal,
          ...(event.terminalState !== undefined ? { terminalState: event.terminalState } : {}),
        });
      return;
    }
    if (!("instance" in event) || event.instance.instanceId !== options.host().instance.instanceId)
      return;
    if (event.type === "instance-updated")
      notify("ui/notifications/tool-input", { arguments: event.instance.content });
  });
  const theme = new MutationObserver(() =>
    notify(
      "ui/notifications/host-context-changed",
      packagedUiHostContext(
        options.host().instance,
        options.host().selectedSession,
        options.host().selectedImages,
        options.displayMode?.(),
      ),
    ),
  );
  theme.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  const resize = new ResizeObserver(([entry]) =>
    notify("ui/notifications/host-context-changed", {
      ...packagedUiHostContext(
        options.host().instance,
        options.host().selectedSession,
        options.host().selectedImages,
        options.displayMode?.(),
      ),
      containerDimensions: { width: entry.contentRect.width, height: entry.contentRect.height },
    }),
  );
  resize.observe(options.frame);
  return {
    update() {
      if (!initialized) return;
      const currentAuthority = authorityKey();
      if (currentAuthority !== lastAuthority) {
        lastAuthority = currentAuthority;
        workspaceInteraction.clearOwner(options.nonce);
        media.close();
      }
      notify("ui/notifications/tool-input", { arguments: options.host().instance.content });
      notify(
        "ui/notifications/host-context-changed",
        packagedUiHostContext(
          options.host().instance,
          options.host().selectedSession,
          options.host().selectedImages,
          options.displayMode?.(),
        ),
      );
    },
    dispose() {
      if (!active) return;
      notify("ui/notifications/teardown", { reason: "Application closed or replaced." });
      active = false;
      for (const request of pending.values())
        void options
          .host()
          .cancelCapability?.(request.idempotencyKey)
          .catch(() => undefined);
      pending.clear();
      window.clearTimeout(timeout);
      unsubscribe();
      unsubscribeWorkspace();
      workspaceInteraction.clearOwner(options.nonce);
      media.dispose();
      theme.disconnect();
      resize.disconnect();
      window.removeEventListener("message", receive);
    },
  };
}
