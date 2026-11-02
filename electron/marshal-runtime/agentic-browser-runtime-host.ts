import { randomUUID } from "node:crypto";

import type { CapabilityDescriptor, CapabilityProvider, InvocationContext } from "@marshal/runtime";
import type {
  LoadedRuntimeExtensionPackage,
  RuntimeExtensionActivation,
} from "@marshal/runtime/extensions";
import type { UiApplicationManifest } from "@marshal/runtime/ui";

import type { RuntimeUiApplicationContent, RuntimeUiJsonValue } from "../../common/runtime-ui";
import {
  AGENTIC_BROWSER_APPLICATION_ID,
  AGENTIC_BROWSER_RENDER_ID,
  AGENTIC_BROWSER_RESOURCE_URI,
} from "../../common/runtime-ui-renderers";
export const AGENTIC_BROWSER_EXTENSION_IDENTITY =
  "@agentic-browser/marshal-runtime-extension" as const;
import {
  type BrowserCommandAdapter,
  isMarshalBrowserCommandName,
  MARSHAL_BROWSER_COMMAND_ADAPTERS,
} from "./browser-command-adapters";
import {
  type MarshalRuntimeBrowserCommandExecutorPort,
  type MarshalRuntimeBrowserRequestContext,
} from "./browser-command-executor";
import {
  MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX,
  type MarshalRuntimeAuthorityPort,
  type MarshalRuntimeScope,
} from "./contracts";
import type { MarshalRuntimeUiController } from "./ui-controller";

const WORKSPACE_METADATA_KEY = "marshalWorkspaceName";
const MAX_ARTIFACT_TEXT_LENGTH = 12_000;
const MAX_SCREENSHOT_BASE64_LENGTH = 12_000;
const BROWSER_APPLICATION: UiApplicationManifest = Object.freeze({
  version: "1.0.0",
  presentationModes: Object.freeze(["inline", "pip"] as const),
  actions: Object.freeze([]),
  tools: Object.freeze([]),
});

interface BrowserLifecycleEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly context: MarshalRuntimeBrowserRequestContext;
  readonly command?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

interface BrowserPanelArtifacts {
  url?: string;
  title?: string;
  accessibility?: string;
  screenshot?: {
    readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
    readonly data: string;
  };
  error?: string;
}

interface BrowserInvocationSession {
  readonly scope: MarshalRuntimeScope;
  readonly context: MarshalRuntimeBrowserRequestContext;
  readonly signal?: AbortSignal;
  lastEvent?: BrowserLifecycleEvent;
  artifacts: BrowserPanelArtifacts;
  uiInstanceId?: string;
}

export interface MarshalAgenticBrowserRuntimeHostModule {
  createId(kind: "browser-session" | "execution" | "event"): string;
  now(): string;
  resolveBrowserSession(context: InvocationContext): {
    readonly context: MarshalRuntimeBrowserRequestContext;
    readonly created: boolean;
  };
  invokeBrowserCommand(
    name: string,
    input: Record<string, unknown>,
    context: MarshalRuntimeBrowserRequestContext,
  ): Promise<unknown>;
  publishLifecycleEvent(event: BrowserLifecycleEvent): Promise<void>;
  openOrFocusPanel(context: MarshalRuntimeBrowserRequestContext): Promise<void>;
  dispose(): Promise<void>;
}

export function createMarshalAgenticBrowserRuntimeHostModule(options: {
  readonly authority: MarshalRuntimeAuthorityPort;
  readonly executor: MarshalRuntimeBrowserCommandExecutorPort;
  readonly ui: MarshalRuntimeUiController;
  readonly onLifecycleEvent?: (event: BrowserLifecycleEvent) => void;
}): MarshalAgenticBrowserRuntimeHostModule {
  const sessionsByKey = new Map<string, BrowserInvocationSession>();
  const sessionsById = new Map<string, BrowserInvocationSession>();

  const requireSession = (
    context: MarshalRuntimeBrowserRequestContext,
  ): BrowserInvocationSession => {
    const session = sessionsById.get(context.browserSessionId);
    if (
      !session ||
      session.context.chatId !== context.chatId ||
      session.context.executionId !== context.executionId
    ) {
      throw new Error("The Marshal agentic browser session context is invalid.");
    }
    return session;
  };

  return Object.freeze({
    createId: () => randomUUID(),
    now: () => new Date().toISOString(),
    resolveBrowserSession(context: InvocationContext) {
      const scope = scopeFromContext(context);
      const executionId = context.executionId?.trim();
      if (!executionId) {
        throw new Error("Marshal agentic browser invocations require an execution identity.");
      }
      // runtimeInvoke assigns a fresh executionId to every tool call. Browser
      // state (tabs, element refs, cookies) belongs to the chat/workspace, not
      // to an individual command execution, so keep one logical session for
      // the full conversation.
      const key = `${scope.sessionId}\0${scope.workspaceName}`;
      const existing = sessionsByKey.get(key);
      if (existing) return { context: existing.context, created: false };
      const browserContext: MarshalRuntimeBrowserRequestContext = Object.freeze({
        chatId: scope.sessionId,
        executionId,
        browserSessionId: randomUUID(),
      });
      const signal = context.signal instanceof AbortSignal ? context.signal : undefined;
      const session: BrowserInvocationSession = {
        scope,
        context: browserContext,
        artifacts: {},
        ...(signal ? { signal } : {}),
      };
      sessionsByKey.set(key, session);
      sessionsById.set(browserContext.browserSessionId, session);
      return { context: browserContext, created: true };
    },
    async invokeBrowserCommand(
      name: string,
      input: Record<string, unknown>,
      context: MarshalRuntimeBrowserRequestContext,
    ) {
      const session = requireSession(context);
      const scope = await options.authority.resolveScope(session.scope, session.signal);
      if (!scope) throw new Error("The Marshal agentic browser session scope is unavailable.");
      return options.executor.execute({
        command: name,
        input,
        context,
        scope,
        ...(session.signal ? { signal: session.signal } : {}),
      });
    },
    async publishLifecycleEvent(event: BrowserLifecycleEvent) {
      const session = requireSession(event.context);
      session.lastEvent = event;
      session.artifacts = mergePanelArtifacts(session.artifacts, event);
      options.onLifecycleEvent?.(event);
      if (!session.uiInstanceId) return;
      requireUiResult(
        await options.ui.update(
          {
            ...session.scope,
            extensionId: AGENTIC_BROWSER_EXTENSION_IDENTITY,
            applicationId: AGENTIC_BROWSER_APPLICATION_ID,
            instanceId: session.uiInstanceId,
            content: panelContent(session),
            idempotencyKey: `browser-event:${event.id}`,
          },
          session.signal,
        ),
      );
    },
    async openOrFocusPanel(context: MarshalRuntimeBrowserRequestContext) {
      const session = requireSession(context);
      if (session.uiInstanceId) {
        requireUiResult(
          await options.ui.focus(
            {
              ...session.scope,
              extensionId: AGENTIC_BROWSER_EXTENSION_IDENTITY,
              applicationId: AGENTIC_BROWSER_APPLICATION_ID,
              instanceId: session.uiInstanceId,
              idempotencyKey: `browser-focus:${context.executionId}`,
            },
            session.signal,
          ),
        );
        return;
      }
      const result = requireUiResult(
        await options.ui.open(
          {
            ...session.scope,
            extensionId: AGENTIC_BROWSER_EXTENSION_IDENTITY,
            applicationId: AGENTIC_BROWSER_APPLICATION_ID,
            surface: "panel",
            content: panelContent(session),
            idempotencyKey: `browser-session:${context.browserSessionId}`,
          },
          session.signal,
        ),
      );
      const instanceId = result.instance?.instanceId;
      if (!instanceId) throw new Error("Marshal Runtime UI did not open the browser panel.");
      session.uiInstanceId = instanceId;
    },
    async dispose() {
      const failures: unknown[] = [];
      const closeResults = await Promise.allSettled(
        [...sessionsById.values()]
          .flatMap((session) =>
            session.uiInstanceId === undefined
              ? []
              : [{ session, instanceId: session.uiInstanceId }],
          )
          .map(async ({ session, instanceId }) =>
            requireUiResult(
              await options.ui.close({
                ...session.scope,
                extensionId: AGENTIC_BROWSER_EXTENSION_IDENTITY,
                applicationId: AGENTIC_BROWSER_APPLICATION_ID,
                instanceId,
                idempotencyKey: `browser-dispose:${session.context.browserSessionId}`,
              }),
            ),
          ),
      );
      for (const result of closeResults) {
        if (result.status === "rejected") {
          const reason: unknown = result.reason;
          failures.push(reason);
        }
      }
      try {
        await options.executor.dispose();
      } catch (error) {
        failures.push(error);
      }
      sessionsByKey.clear();
      sessionsById.clear();
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose the Marshal agentic browser host.");
      }
    },
  });
}

export function adaptAgenticBrowserExtensionPackage(
  loaded: LoadedRuntimeExtensionPackage,
): LoadedRuntimeExtensionPackage {
  const activate = loaded.module.activate.bind(loaded.module);
  return {
    ...loaded,
    module: {
      activate: async (context) => adaptActivation(await activate(context)),
    },
  };
}

function adaptActivation(activation: RuntimeExtensionActivation): RuntimeExtensionActivation {
  return {
    ...activation,
    capabilityProviders: activation.capabilityProviders?.map(adaptCapabilityProvider),
  };
}

function adaptCapabilityProvider(provider: CapabilityProvider): CapabilityProvider {
  const adapt = (
    descriptor: CapabilityDescriptor | undefined,
  ): CapabilityDescriptor | undefined => {
    if (!descriptor || !isMarshalBrowserCommandName(descriptor.name)) return undefined;
    const adapter = (MARSHAL_BROWSER_COMMAND_ADAPTERS as Record<string, BrowserCommandAdapter>)[
      descriptor.name
    ];
    return Object.freeze({
      ...descriptor,
      title: adapter?.title ?? descriptor.title,
      description: adapter?.description ?? descriptor.description,
      inputSchema: adapter?.inputSchema ?? descriptor.inputSchema,
      permissions: Object.freeze([
        {
          permission: `${MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX}${descriptor.name}`,
          risk: adapter?.risk ?? "medium",
          reason: `Invokes ${descriptor.name} through Agentic Browser's in-process CDP backend.`,
        },
      ]),
      annotations: Object.freeze({
        ...(descriptor.annotations ?? {}),
        transport: "agentic-browser-cdp",
        targetTool: adapter?.target ?? descriptor.name,
      }),
    });
  };
  return {
    ...provider,
    async list(context) {
      const descriptors = await provider.list(context);
      return Object.freeze(
        descriptors
          .map((descriptor) => adapt(descriptor))
          .filter((descriptor): descriptor is CapabilityDescriptor => descriptor !== undefined),
      );
    },
    async get(name, context) {
      if (!isMarshalBrowserCommandName(name)) return undefined;
      return adapt(await provider.get?.(name, context));
    },
    invoke: provider.invoke.bind(provider),
  };
}

function scopeFromContext(context: InvocationContext): MarshalRuntimeScope {
  const sessionId = context.scope?.sessionId?.trim();
  const workspaceName = context.metadata?.[WORKSPACE_METADATA_KEY];
  if (!sessionId || typeof workspaceName !== "string" || !workspaceName.trim()) {
    throw new Error("Marshal agentic browser invocations require a session and workspace scope.");
  }
  return { sessionId, workspaceName: workspaceName.trim() };
}

function panelContent(session: BrowserInvocationSession): RuntimeUiApplicationContent {
  const event = session.lastEvent;
  const status =
    event?.type === "completion"
      ? "completed"
      : event?.type === "failure"
        ? "failed"
        : event?.type === "navigation"
          ? "navigating"
          : event?.type === "pause"
            ? "waiting"
            : "active";
  const state: Record<string, RuntimeUiJsonValue> = {
    status,
    executionId: session.context.executionId,
    updatedAt: event?.occurredAt ?? new Date().toISOString(),
    ...(event?.command ? { command: event.command } : {}),
    ...session.artifacts,
  };
  return {
    kind: "application",
    renderId: AGENTIC_BROWSER_RENDER_ID,
    resource: {
      uri: AGENTIC_BROWSER_RESOURCE_URI,
      mimeType: "text/html",
      name: "Agentic Browser",
    },
    descriptor: BROWSER_APPLICATION,
    state,
  };
}

function mergePanelArtifacts(
  current: BrowserPanelArtifacts,
  event: BrowserLifecycleEvent,
): BrowserPanelArtifacts {
  const artifacts = { ...current };
  const input = record(event.details?.["input"]);
  if (typeof input?.["url"] === "string") artifacts.url = clipped(input["url"], 2_048);
  if (event.type === "failure") {
    const error = record(event.details?.["error"]);
    if (typeof error?.["message"] === "string") {
      artifacts.error = clipped(error["message"], 1_024);
    }
  } else if (event.type === "completion") {
    delete artifacts.error;
  }

  const result = record(event.details?.["result"]);
  const data = record(result?.["data"]);
  const content = Array.isArray(data?.["content"]) ? data["content"] : [];
  for (const value of content) {
    const block = record(value);
    if (!block) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      mergeTextArtifacts(artifacts, block["text"], event.command);
      continue;
    }
    if (
      block["type"] === "image" &&
      typeof block["data"] === "string" &&
      block["data"].length <= MAX_SCREENSHOT_BASE64_LENGTH &&
      isScreenshotMime(block["mimeType"])
    ) {
      artifacts.screenshot = { mimeType: block["mimeType"], data: block["data"] };
      continue;
    }
    const resource = record(block["resource"]);
    if (typeof resource?.["text"] === "string") {
      mergeTextArtifacts(artifacts, resource["text"], event.command);
    }
  }
  return artifacts;
}

function mergeTextArtifacts(
  artifacts: BrowserPanelArtifacts,
  value: string,
  command: string | undefined,
): void {
  const url = value.match(/(?:Page URL|URL):\s*(\S+)/i)?.[1];
  const title = value.match(/(?:Page Title|Title):\s*(.+)/i)?.[1]?.trim();
  const snapshot = value.match(
    /(?:Page Snapshot|Accessibility(?: Tree)?):\s*```(?:ya?ml)?\s*([\s\S]*?)```/i,
  )?.[1];
  if (url) artifacts.url = clipped(url, 2_048);
  if (title) artifacts.title = clipped(title, 1_024);
  if (snapshot) artifacts.accessibility = clipped(snapshot.trim(), MAX_ARTIFACT_TEXT_LENGTH);
  if (
    command === "browser_accessibility_tree" &&
    !snapshot &&
    value.trim() &&
    !artifacts.accessibility
  ) {
    artifacts.accessibility = clipped(value.trim(), MAX_ARTIFACT_TEXT_LENGTH);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isUnknownRecord(value) ? value : undefined;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipped(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}

function isScreenshotMime(value: unknown): value is "image/png" | "image/jpeg" | "image/webp" {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

function requireUiResult<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | {
        readonly ok: false;
        readonly error: { readonly code: string; readonly message: string };
      },
): T {
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.message), { code: result.error.code });
}
