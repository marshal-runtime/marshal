import { randomUUID } from "node:crypto";

import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import type { RuntimeUiInstance, RuntimeUiScope, RuntimeUiSurface } from "../common/runtime-ui";
import { MARSHAL_RUNTIME_DEFAULT_WORKSPACE } from "../common/runtime-ui";
import type { MarshalUiViewport } from "../common/runtime-ui-viewports";
import { invalidRuntimeRequest } from "./marshal-runtime/runtime-provider-error";

/**
 * UI observability (Omer's visual QA gate, interactive-session design): mount
 * extension UI in a hidden observer window at the TRUE mobile or desktop
 * presentation — the same packaged sandbox/bridge pipeline the real clients
 * run — then screenshot it (ui.observe.capture) or hand out its CDP target on
 * the app's existing debug port so agents drive it interactively with
 * agentic-browser (ui.observe.open / ui.observe.close).
 *
 * The CDP target is ALWAYS the observer's own hidden window. Observing a live
 * instanceId mounts a mirror view of that instance — agents never attach to or
 * inject input into the user's real window. v1 audits the session ledger
 * (open / close / expiry per requester and target); per-interaction CDP
 * traffic is NOT audited.
 */
export const UI_OBSERVE_CAPTURE = "ui.observe.capture";
export const UI_OBSERVE_OPEN = "ui.observe.open";
export const UI_OBSERVE_CLOSE = "ui.observe.close";

/** Base64 ceiling ≈ 9 MB of PNG — same order as the packaged-UI transport caps. */
export const UI_OBSERVE_MAX_BASE64_LENGTH = 12_000_000;
export const UI_OBSERVE_MAX_SETTLE_MS = 10_000;
export const UI_OBSERVE_DEFAULT_TTL_MS = 600_000;
export const UI_OBSERVE_MAX_TTL_MS = 1_800_000;
export const UI_OBSERVE_MIN_TTL_MS = 5_000;
export const UI_OBSERVE_MAX_CONCURRENT = 3;

const SURFACES: readonly RuntimeUiSurface[] = ["inline-card", "fullscreen", "tab", "panel"];

export interface UiObserveRenderRequest {
  readonly mode: "application" | "instance";
  readonly extensionId?: string;
  readonly applicationId?: string;
  readonly instanceId?: string;
  readonly scope: RuntimeUiScope;
  readonly viewport: MarshalUiViewport;
  readonly surface?: RuntimeUiSurface;
  readonly settleMs: number;
  readonly fullPage: boolean;
}

export interface UiObserveWindowHandle {
  readonly webContentsId: number;
  /** Unique marker present in the observer window's URL; CDP target resolution
   *  matches on it and can therefore never select the user's window. */
  readonly urlMarker: string;
  readonly width: number;
  readonly height: number;
  readonly capture: (options: {
    readonly settleMs: number;
    readonly fullPage: boolean;
  }) => Promise<{ readonly pngBase64: string; readonly width: number; readonly height: number }>;
  readonly destroy: () => void;
}

export interface UiObserveDeps {
  /** Published-application lookup — the ONLY way an application target resolves. */
  readonly findPublishedApplication: (
    extensionId: string,
    applicationId: string,
    context: InvocationContext,
  ) => Promise<{ readonly viewports: ReadonlySet<MarshalUiViewport> | null } | undefined>;
  /** Instance lookup, scoped exactly like ui.list — never a global index. */
  readonly findScopedInstance: (
    scope: RuntimeUiScope,
    instanceId: string,
  ) => Promise<RuntimeUiInstance | undefined>;
  /** One-shot offscreen render + capture (ui-observe-window.ts). */
  readonly capture: (
    request: UiObserveRenderRequest,
  ) => Promise<{ readonly pngBase64: string; readonly width: number; readonly height: number }>;
  /** Held observer window for interactive sessions (ui-observe-window.ts). */
  readonly openWindow?: (request: UiObserveRenderRequest) => Promise<UiObserveWindowHandle>;
  /** Resolve the observer window's CDP target id on the app's debug port by
   *  its URL marker; null when the debug port is unavailable. */
  readonly resolveCdpTargetId?: (urlMarker: string) => Promise<string | null>;
  /** One ledger entry per capture attempt and per observer-session event. */
  readonly audit: (entry: {
    readonly sessionId: string;
    readonly target: string;
    readonly viewport: string;
    readonly decision: "approved" | "denied";
    readonly reason?: string;
  }) => void;
}

const targetProperties = {
  extensionId: { type: "string", minLength: 1, maxLength: 256 },
  applicationId: { type: "string", minLength: 1, maxLength: 256 },
  instanceId: { type: "string", minLength: 1, maxLength: 128 },
  viewport: { enum: ["mobile", "desktop"] },
  surface: { enum: [...SURFACES] },
} as const;

const captureDescriptor: CapabilityDescriptor = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  name: UI_OBSERVE_CAPTURE,
  version: "1.0.0",
  title: "Screenshot extension UI at a mobile or desktop viewport",
  description:
    "Captures a PNG of a published extension application (extensionId + applicationId), a live " +
    "session-owned component (instanceId), or an already-open observer session (observerSessionId). " +
    "One-shot targets render in a hidden observer window at the requested viewport — mobile is the " +
    'true phone presentation (390×844, remote-client semantics, UiHostContext formFactor "mobile"), ' +
    "not a resized desktop. Only UI already published in the runtime is observable; requesters can " +
    "observe exactly what their own scope could open.",
  tags: ["marshal", "ui", "observe", "screenshot", "mobile", "desktop", "visual-qa"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...targetProperties,
      observerSessionId: { type: "string", minLength: 1, maxLength: 128 },
      settleMs: { type: "integer", minimum: 0, maximum: UI_OBSERVE_MAX_SETTLE_MS },
      fullPage: { type: "boolean" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pngBase64", "width", "height", "viewport"],
    properties: {
      pngBase64: { type: "string", maxLength: UI_OBSERVE_MAX_BASE64_LENGTH },
      width: { type: "integer", minimum: 1 },
      height: { type: "integer", minimum: 1 },
      viewport: { enum: ["mobile", "desktop"] },
      instanceId: { type: "string" },
    },
  },
  permissions: [{ permission: UI_OBSERVE_CAPTURE, risk: "low" }],
};

const openDescriptor: CapabilityDescriptor = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  name: UI_OBSERVE_OPEN,
  version: "1.0.0",
  title: "Open an interactive observer session on extension UI",
  description:
    "Mounts a published extension application or a mirror of a live session-owned component in a " +
    "hidden observer window at the requested viewport and returns its CDP target id on the app's " +
    "debug port (attach with agentic-browser: --port 9333 --target <id>). The target is ALWAYS the " +
    "observer's own window — never the user's. Sessions expire on their TTL or via ui.observe.close; " +
    `at most ${UI_OBSERVE_MAX_CONCURRENT} observers run concurrently. The session ledger is audited; ` +
    "per-interaction CDP traffic is not (v1).",
  tags: ["marshal", "ui", "observe", "cdp", "interactive", "mobile", "desktop", "visual-qa"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["viewport"],
    properties: {
      ...targetProperties,
      ttlMs: {
        type: "integer",
        minimum: UI_OBSERVE_MIN_TTL_MS,
        maximum: UI_OBSERVE_MAX_TTL_MS,
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["observerSessionId", "cdpTargetId", "expiresAt", "viewport", "width", "height"],
    properties: {
      observerSessionId: { type: "string" },
      cdpTargetId: { type: ["string", "null"] },
      expiresAt: { type: "string" },
      viewport: { enum: ["mobile", "desktop"] },
      width: { type: "integer", minimum: 1 },
      height: { type: "integer", minimum: 1 },
    },
  },
  permissions: [{ permission: UI_OBSERVE_OPEN, risk: "low" }],
};

const closeDescriptor: CapabilityDescriptor = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  name: UI_OBSERVE_CLOSE,
  version: "1.0.0",
  title: "Close an observer session",
  description:
    "Destroys an observer window opened by ui.observe.open and invalidates its CDP target. Only the " +
    "scope that opened the session may close it; TTL expiry closes it automatically.",
  tags: ["marshal", "ui", "observe"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["observerSessionId"],
    properties: { observerSessionId: { type: "string", minLength: 1, maxLength: 128 } },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["closed"],
    properties: { closed: { type: "boolean" } },
  },
  permissions: [{ permission: UI_OBSERVE_CLOSE, risk: "low" }],
};

interface ParsedTarget {
  readonly mode: "application" | "instance" | "session";
  readonly extensionId?: string;
  readonly applicationId?: string;
  readonly instanceId?: string;
  readonly observerSessionId?: string;
  readonly viewport?: MarshalUiViewport;
  readonly surface?: RuntimeUiSurface;
  readonly settleMs: number;
  readonly fullPage: boolean;
  readonly ttlMs: number;
}

function parseCommon(
  input: unknown,
  allowed: ReadonlySet<string>,
  options: { readonly allowSession: boolean; readonly requireViewport: boolean },
): ParsedTarget {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalidRuntimeRequest(new TypeError("Observe input must be an object."));
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
  const request = input as Record<string, unknown>;
  if (Object.keys(request).some((key) => !allowed.has(key)))
    throw invalidRuntimeRequest(new TypeError("Unexpected observe input property."));
  const hasApplication =
    typeof request.extensionId === "string" && typeof request.applicationId === "string";
  const hasInstance = typeof request.instanceId === "string";
  const hasSession = options.allowSession && typeof request.observerSessionId === "string";
  const targetCount = Number(hasApplication) + Number(hasInstance) + Number(hasSession);
  if (targetCount !== 1)
    throw invalidRuntimeRequest(
      new TypeError(
        "Observe exactly one target: extensionId + applicationId, instanceId, or observerSessionId.",
      ),
    );
  const viewport = request.viewport;
  if (viewport !== undefined && viewport !== "mobile" && viewport !== "desktop")
    throw invalidRuntimeRequest(new TypeError('Observe viewport must be "mobile" or "desktop".'));
  if (options.requireViewport && !hasSession && viewport === undefined)
    throw invalidRuntimeRequest(new TypeError("Observe viewport is required."));
  const settleMs = request.settleMs ?? 0;
  if (
    typeof settleMs !== "number" ||
    !Number.isInteger(settleMs) ||
    settleMs < 0 ||
    settleMs > UI_OBSERVE_MAX_SETTLE_MS
  )
    throw invalidRuntimeRequest(
      new TypeError(
        `Observe settleMs must be an integer between 0 and ${UI_OBSERVE_MAX_SETTLE_MS}.`,
      ),
    );
  const ttlMs = request.ttlMs ?? UI_OBSERVE_DEFAULT_TTL_MS;
  if (
    typeof ttlMs !== "number" ||
    !Number.isInteger(ttlMs) ||
    ttlMs < UI_OBSERVE_MIN_TTL_MS ||
    ttlMs > UI_OBSERVE_MAX_TTL_MS
  )
    throw invalidRuntimeRequest(
      new TypeError(
        `Observer ttlMs must be an integer between ${UI_OBSERVE_MIN_TTL_MS} and ${UI_OBSERVE_MAX_TTL_MS}.`,
      ),
    );
  const surface = request.surface;
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
  if (surface !== undefined && !SURFACES.includes(surface as RuntimeUiSurface))
    throw invalidRuntimeRequest(new TypeError("Unknown observe surface."));
  if (request.fullPage !== undefined && typeof request.fullPage !== "boolean")
    throw invalidRuntimeRequest(new TypeError("Observe fullPage must be a boolean."));
  return {
    mode: hasSession ? "session" : hasApplication ? "application" : "instance",
    ...(hasApplication
      ? {
          // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
          extensionId: request.extensionId as string,
          // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
          applicationId: request.applicationId as string,
        }
      : {}),
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
    ...(hasInstance ? { instanceId: request.instanceId as string } : {}),
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
    ...(hasSession ? { observerSessionId: request.observerSessionId as string } : {}),
    ...(viewport !== undefined ? { viewport } : {}),
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
    ...(surface !== undefined ? { surface: surface as RuntimeUiSurface } : {}),
    settleMs,
    fullPage: request.fullPage === true,
    ttlMs,
  };
}

const CAPTURE_KEYS = new Set([
  "extensionId",
  "applicationId",
  "instanceId",
  "observerSessionId",
  "viewport",
  "surface",
  "settleMs",
  "fullPage",
]);
const OPEN_KEYS = new Set([
  "extensionId",
  "applicationId",
  "instanceId",
  "viewport",
  "surface",
  "ttlMs",
]);
const CLOSE_KEYS = new Set(["observerSessionId"]);

function requesterScope(context: InvocationContext): {
  readonly sessionId?: string;
  readonly workspaceName: string;
} {
  const sessionId =
    typeof context.scope?.sessionId === "string" && context.scope.sessionId.trim()
      ? context.scope.sessionId
      : undefined;
  const workspace = context.metadata?.marshalWorkspaceName;
  return {
    ...(sessionId ? { sessionId } : {}),
    workspaceName:
      typeof workspace === "string" && workspace.trim()
        ? workspace
        : MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
  };
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

interface ObserverSession {
  readonly observerSessionId: string;
  readonly ownerKey: string;
  readonly target: string;
  readonly viewport: MarshalUiViewport;
  readonly handle: UiObserveWindowHandle;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createUiObserveProvider(deps: UiObserveDeps): CapabilityProvider {
  const sessions = new Map<string, ObserverSession>();

  const closeSession = (session: ObserverSession, reason: string): void => {
    sessions.delete(session.observerSessionId);
    clearTimeout(session.timer);
    try {
      session.handle.destroy();
    } finally {
      deps.audit({
        sessionId: session.ownerKey,
        target: session.target,
        viewport: session.viewport,
        decision: "approved",
        reason,
      });
    }
  };

  /** Owner pin: only the scope that opened a session may address it, and the
   *  denial never reveals whether the session exists. */
  const requireOwnedSession = (observerSessionId: string, ownerKey: string): ObserverSession => {
    const session = sessions.get(observerSessionId);
    if (!session || session.ownerKey !== ownerKey)
      throw coded("permission_denied", "No observer session with this id exists in your scope.");
    return session;
  };

  const resolveRenderRequest = async (
    parsed: ParsedTarget,
    context: InvocationContext,
    deny: (code: string, reason: string) => never,
  ): Promise<UiObserveRenderRequest> => {
    const requester = requesterScope(context);
    if (parsed.mode === "application") {
      const application = await deps.findPublishedApplication(
        parsed.extensionId!,
        parsed.applicationId!,
        context,
      );
      if (!application)
        return deny(
          "not_found",
          "Only published extension applications can be observed; this one is not published.",
        );
      if (parsed.viewport === "mobile" && !application.viewports?.has("mobile"))
        return deny(
          "invalid_request",
          "The application declares no mobile view (marshal.ui.viewports); observe it at the desktop viewport instead.",
        );
      return {
        mode: "application",
        extensionId: parsed.extensionId!,
        applicationId: parsed.applicationId!,
        // M3: mount under the REQUESTER's own session scope so the extension
        // executes with the same effective read authority a real pane bound to
        // that session would have — scope-keyed state (accounts, connections)
        // resolves identically. This delegates only authority the requester
        // already holds (it could invoke the extension's capabilities under
        // its session directly), and keeps the observer's instance separate
        // from the shared user-scope pane. Sessionless requesters fall back to
        // the shared user scope.
        scope: requester.sessionId
          ? { sessionId: requester.sessionId, workspaceName: requester.workspaceName }
          : { applicationScope: "user", workspaceName: requester.workspaceName },
        viewport: parsed.viewport!,
        ...(parsed.surface ? { surface: parsed.surface } : {}),
        settleMs: parsed.settleMs,
        fullPage: parsed.fullPage,
      };
    }
    // Owning-lineage pin: an instance resolves only through the requester's own
    // session scope or the shared user scope — exactly the scopes whose
    // instances the requester could already open/list. The observer mounts a
    // MIRROR of the instance in its own hidden window; it never attaches to the
    // user's window.
    const owned = requester.sessionId
      ? await deps.findScopedInstance(
          { sessionId: requester.sessionId, workspaceName: requester.workspaceName },
          parsed.instanceId!,
        )
      : undefined;
    const shared = owned
      ? undefined
      : await deps.findScopedInstance(
          { applicationScope: "user", workspaceName: requester.workspaceName },
          parsed.instanceId!,
        );
    const instance = owned ?? shared;
    if (!instance)
      return deny(
        "permission_denied",
        "No observable component with this instance id exists in your scope.",
      );
    return {
      mode: "instance",
      instanceId: instance.instanceId,
      extensionId: instance.owner.extensionId,
      applicationId: instance.owner.applicationId,
      scope: instance.owner.applicationScope
        ? {
            applicationScope: instance.owner.applicationScope,
            workspaceName: instance.owner.workspaceName,
          }
        : { sessionId: instance.owner.sessionId, workspaceName: instance.owner.workspaceName },
      viewport: parsed.viewport!,
      ...(parsed.surface ? { surface: parsed.surface } : {}),
      settleMs: parsed.settleMs,
      fullPage: parsed.fullPage,
    };
  };

  return {
    id: "marshal.ui-observe",
    version: "1.0.0",
    list: () => [captureDescriptor, openDescriptor, closeDescriptor],
    get: (name) =>
      name === UI_OBSERVE_CAPTURE
        ? captureDescriptor
        : name === UI_OBSERVE_OPEN
          ? openDescriptor
          : name === UI_OBSERVE_CLOSE
            ? closeDescriptor
            : undefined,
    async invoke(name, input, context) {
      const requester = requesterScope(context);
      const ownerKey = requester.sessionId ?? "";
      if (name === UI_OBSERVE_CLOSE) {
        const parsed = (() => {
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw invalidRuntimeRequest(new TypeError("Observe input must be an object."));
          // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
          const request = input as Record<string, unknown>;
          if (Object.keys(request).some((key) => !CLOSE_KEYS.has(key)))
            throw invalidRuntimeRequest(new TypeError("Unexpected observe input property."));
          if (typeof request.observerSessionId !== "string" || !request.observerSessionId.trim())
            throw invalidRuntimeRequest(new TypeError("observerSessionId is required."));
          return request.observerSessionId;
        })();
        const session = requireOwnedSession(parsed, ownerKey);
        closeSession(session, "session-close");
        return { output: { closed: true } };
      }
      if (name === UI_OBSERVE_OPEN) {
        if (!deps.openWindow)
          throw coded("unavailable", "Interactive observer sessions are unavailable on this host.");
        const parsed = parseCommon(input, OPEN_KEYS, {
          allowSession: false,
          requireViewport: true,
        });
        const target =
          parsed.mode === "application"
            ? `${parsed.extensionId}/${parsed.applicationId}`
            : `instance:${parsed.instanceId}`;
        const deny = (code: string, reason: string): never => {
          deps.audit({
            sessionId: ownerKey,
            target,
            viewport: parsed.viewport ?? "",
            decision: "denied",
            reason,
          });
          throw coded(code, reason);
        };
        if (sessions.size >= UI_OBSERVE_MAX_CONCURRENT)
          return deny(
            "resource_exhausted",
            `At most ${UI_OBSERVE_MAX_CONCURRENT} observer sessions may run concurrently; close one first.`,
          );
        const renderRequest = await resolveRenderRequest(parsed, context, deny);
        let handle: UiObserveWindowHandle;
        try {
          handle = await deps.openWindow(renderRequest);
        } catch (error) {
          return deny(
            // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
            typeof (error as { code?: unknown }).code === "string"
              ? // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
                (error as { code: string }).code
              : "operation_failed",
            error instanceof Error ? error.message : "The observer window could not be opened.",
          );
        }
        const observerSessionId = randomUUID();
        const expiresAtMs = Date.now() + parsed.ttlMs;
        const timer = setTimeout(() => {
          const session = sessions.get(observerSessionId);
          if (session) closeSession(session, "session-expired");
        }, parsed.ttlMs);
        timer.unref?.();
        sessions.set(observerSessionId, {
          observerSessionId,
          ownerKey,
          target,
          viewport: renderRequest.viewport,
          handle,
          expiresAt: expiresAtMs,
          timer,
        });
        const cdpTargetId = deps.resolveCdpTargetId
          ? await deps.resolveCdpTargetId(handle.urlMarker).catch(() => null)
          : null;
        deps.audit({
          sessionId: ownerKey,
          target,
          viewport: renderRequest.viewport,
          decision: "approved",
          reason: "session-open",
        });
        return {
          output: {
            observerSessionId,
            cdpTargetId,
            expiresAt: new Date(expiresAtMs).toISOString(),
            viewport: renderRequest.viewport,
            width: handle.width,
            height: handle.height,
          },
        };
      }
      if (name !== UI_OBSERVE_CAPTURE) throw coded("not_found", "UI observe capability not found.");
      const parsed = parseCommon(input, CAPTURE_KEYS, {
        allowSession: true,
        requireViewport: true,
      });
      if (parsed.mode === "session") {
        const session = requireOwnedSession(parsed.observerSessionId!, ownerKey);
        const captured = await session.handle.capture({
          settleMs: parsed.settleMs,
          fullPage: parsed.fullPage,
        });
        if (captured.pngBase64.length > UI_OBSERVE_MAX_BASE64_LENGTH)
          throw coded("invalid_request", "The capture exceeded the bounded image size.");
        deps.audit({
          sessionId: ownerKey,
          target: session.target,
          viewport: session.viewport,
          decision: "approved",
        });
        return {
          output: {
            pngBase64: captured.pngBase64,
            width: captured.width,
            height: captured.height,
            viewport: session.viewport,
          },
        };
      }
      const target =
        parsed.mode === "application"
          ? `${parsed.extensionId}/${parsed.applicationId}`
          : `instance:${parsed.instanceId}`;
      const deny = (code: string, reason: string): never => {
        deps.audit({
          sessionId: ownerKey,
          target,
          viewport: parsed.viewport ?? "",
          decision: "denied",
          reason,
        });
        throw coded(code, reason);
      };
      const renderRequest = await resolveRenderRequest(parsed, context, deny);
      let captured: Awaited<ReturnType<UiObserveDeps["capture"]>>;
      try {
        captured = await deps.capture(renderRequest);
      } catch (error) {
        return deny(
          // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
          typeof (error as { code?: unknown }).code === "string"
            ? // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
              (error as { code: string }).code
            : "operation_failed",
          error instanceof Error ? error.message : "The observer capture failed.",
        );
      }
      if (captured.pngBase64.length > UI_OBSERVE_MAX_BASE64_LENGTH)
        return deny(
          "invalid_request",
          "The capture exceeded the bounded image size; reduce the viewport or disable fullPage.",
        );
      deps.audit({
        sessionId: ownerKey,
        target,
        viewport: renderRequest.viewport,
        decision: "approved",
      });
      return {
        output: {
          pngBase64: captured.pngBase64,
          width: captured.width,
          height: captured.height,
          viewport: renderRequest.viewport,
          ...(renderRequest.instanceId ? { instanceId: renderRequest.instanceId } : {}),
        },
      };
    },
  };
}
