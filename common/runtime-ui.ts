import type { RuntimeExtensionUiHostPlacement } from "@marshal/runtime/extensions";
import type { UiApplicationManifest } from "@marshal/runtime/ui";

import type { MarshalUiViewport } from "./runtime-ui-viewports";

export type RuntimeUiSurface =
  | "inline-card"
  | "fullscreen"
  | "tab"
  | "panel"
  | "bottom-panel"
  | "floating";

export const RUNTIME_UI_SURFACES: readonly RuntimeUiSurface[] = [
  "inline-card",
  "fullscreen",
  "tab",
  "panel",
  "bottom-panel",
  "floating",
];

export type RuntimeUiJsonPrimitive = string | number | boolean | null;
export type RuntimeUiJsonValue =
  | RuntimeUiJsonPrimitive
  | readonly RuntimeUiJsonValue[]
  | { readonly [key: string]: RuntimeUiJsonValue };

export type RuntimeUiPlacementMode = "augment" | "fallback" | "replace";

export const RUNTIME_UI_PLACEMENT = {
  NAV_PRIMARY: "nav.primary",
  CHAT_COMPOSER_ADD: "chat.composer.add",
  CHAT_COMPOSER_ACTIONS: "chat.composer.actions",
  CHAT_COMPOSER_ADD_CONTENT: {
    id: "chat.composer.add",
    target: "chat.composer",
    placement: "add",
  },
  CHAT_SLASH_COMMAND: "chat.slash-command",
} as const;

export const MARSHAL_CHAT_COMPOSER_ADD_PLACEMENT_ID = "marshal.chat.composer.add" as const;
export const MARSHAL_CHAT_SLASH_COMMAND_PLACEMENT_ID = "marshal.chat.slash-command" as const;

export interface RuntimeUiPlacementComponentMetadata {
  readonly id: string;
  readonly target: string;
  readonly kind: "button";
  readonly label: string;
  readonly icon: "plus";
  readonly action: "file-upload";
}

export interface RuntimeUiPlacementMetadata {
  readonly id: string;
  readonly key: string;
  readonly parentId: string;
  readonly target: string;
  readonly placement: string;
  readonly title: string;
  readonly description: string;
  readonly supportedModes: readonly RuntimeUiPlacementMode[];
  readonly supportsFullReplacement: boolean;
  readonly augmentationPresentation: "context-menu" | "navigation" | "toolbar";
  readonly defaultComponent?: RuntimeUiPlacementComponentMetadata;
}

function placementMetadata(
  value: Omit<RuntimeUiPlacementMetadata, "key" | "target" | "placement">,
): RuntimeUiPlacementMetadata {
  const [target, placement] = splitPlacementId(value.id);
  return Object.freeze({
    ...value,
    key: value.id,
    target,
    placement,
    supportedModes: Object.freeze([...value.supportedModes]),
    ...(value.defaultComponent
      ? { defaultComponent: Object.freeze({ ...value.defaultComponent }) }
      : {}),
  });
}

export const RUNTIME_UI_HOST_PLACEMENTS: readonly RuntimeUiPlacementMetadata[] = Object.freeze([
  placementMetadata({
    id: RUNTIME_UI_PLACEMENT.CHAT_COMPOSER_ACTIONS,
    parentId: "chat.composer",
    title: "Chat composer actions",
    description: "Extension application buttons beside the chat input.",
    supportedModes: ["augment"],
    supportsFullReplacement: false,
    augmentationPresentation: "toolbar",
  }),
  placementMetadata({
    id: RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
    parentId: "nav",
    title: "Primary navigation",
    description:
      "Persistent extension applications in the main navigation, available without a chat.",
    supportedModes: ["augment"],
    supportsFullReplacement: false,
    augmentationPresentation: "navigation",
  }),
  placementMetadata({
    id: RUNTIME_UI_PLACEMENT.CHAT_COMPOSER_ADD,
    parentId: "chat.composer",
    title: "Chat composer add button",
    description:
      "The default plus button uploads a file. Extensions may augment it with menu actions or replace it completely.",
    supportedModes: ["augment", "fallback", "replace"],
    supportsFullReplacement: true,
    augmentationPresentation: "context-menu",
    defaultComponent: {
      id: "marshal.chat.file-upload",
      target: `${RUNTIME_UI_PLACEMENT.CHAT_COMPOSER_ADD}.file-upload`,
      kind: "button",
      label: "Upload file",
      icon: "plus",
      action: "file-upload",
    },
  }),
  placementMetadata({
    id: RUNTIME_UI_PLACEMENT.CHAT_SLASH_COMMAND,
    parentId: "chat.composer",
    title: "Chat slash commands",
    description: "Composer `/` commands. Extensions may augment the list with additional commands.",
    supportedModes: ["augment", "fallback", "replace"],
    supportsFullReplacement: true,
    augmentationPresentation: "context-menu",
    defaultComponent: {
      id: "marshal.chat.slash-command.host",
      target: `${RUNTIME_UI_PLACEMENT.CHAT_SLASH_COMMAND}.host`,
      kind: "button",
      label: "Commands",
      icon: "plus",
      action: "file-upload",
    },
  }),
]);

export function runtimeExtensionPlacementId(placementId: string): string {
  if (placementId === RUNTIME_UI_PLACEMENT.CHAT_COMPOSER_ACTIONS)
    return "marshal.chat.composer.actions";
  if (placementId === RUNTIME_UI_PLACEMENT.CHAT_COMPOSER_ADD) {
    return MARSHAL_CHAT_COMPOSER_ADD_PLACEMENT_ID;
  }
  if (placementId === RUNTIME_UI_PLACEMENT.CHAT_SLASH_COMMAND) {
    return MARSHAL_CHAT_SLASH_COMMAND_PLACEMENT_ID;
  }
  return placementId;
}

const RUNTIME_UI_EXTENSION_HOST_PLACEMENT_IDS = new Set(
  RUNTIME_UI_HOST_PLACEMENTS.map((placement) => runtimeExtensionPlacementId(placement.id)),
);

export const RUNTIME_UI_EXTENSION_HOST_PLACEMENTS: readonly RuntimeExtensionUiHostPlacement[] =
  Object.freeze(
    RUNTIME_UI_HOST_PLACEMENTS.map((placement) =>
      Object.freeze({
        placementId: runtimeExtensionPlacementId(placement.id),
        ...(RUNTIME_UI_EXTENSION_HOST_PLACEMENT_IDS.has(
          runtimeExtensionPlacementId(placement.parentId),
        )
          ? { parentPlacementId: runtimeExtensionPlacementId(placement.parentId) }
          : {}),
        metadata: Object.freeze({
          title: placement.title,
          description: placement.description,
          hasHostContent: Boolean(placement.defaultComponent),
          supportedActions: Object.freeze([...placement.supportedModes]),
          supportsFullReplacement: placement.supportsFullReplacement,
        }),
      }),
    ),
  );

function splitPlacementId(id: string): readonly [target: string, placement: string] {
  const separator = id.lastIndexOf(".");
  return separator > 0 ? [id.slice(0, separator), id.slice(separator + 1)] : ["", id];
}

export interface RuntimeUiPlacementApplication {
  readonly extensionId: string;
  readonly applicationId: string;
  readonly title: string;
  readonly description: string;
  readonly renderId: string;
  readonly action: RuntimeUiPlacementMode;
  readonly replacement?: "placement" | "full";
  /** Published manifest declarations; absent when the publication record carries no manifest. */
  readonly actions?: UiApplicationManifest["actions"];
  readonly tools?: UiApplicationManifest["tools"];
  /** Publication revision the projected application was resolved from. */
  readonly revisionId?: string;
  /**
   * Client viewports the publication declares it serves via its metadata
   * record (marshal.ui.viewports — see common/runtime-ui-viewports.ts).
   * Absent = undeclared: not shown on mobile. Declaration is deliberate; the
   * host never infers it from document markup.
   */
  readonly viewports?: readonly MarshalUiViewport[];
}

export type RuntimeUiPlacementDiagnosticCode =
  | "exact-target-collision"
  | "invalid-component"
  | "invalid-registration"
  | "invocation-failed"
  | "target-hierarchy-collision"
  | "unsupported-mode"
  | "unsupported-placement"
  | "unsupported-target";

export interface RuntimeUiPlacementDiagnostic {
  readonly id: string;
  readonly code: RuntimeUiPlacementDiagnosticCode;
  readonly severity: "error";
  readonly message: string;
  readonly repairHint: string;
  readonly placementId: string;
  readonly targets: readonly string[];
  readonly extensionIds: readonly string[];
  readonly registrationIds: readonly string[];
}

export interface RuntimeUiPlacementResolution {
  readonly metadata: RuntimeUiPlacementMetadata;
  readonly applications: readonly RuntimeUiPlacementApplication[];
}

export interface RuntimeUiPlacementSnapshot {
  readonly revision: number;
  readonly generatedAt: string;
  readonly placements: readonly RuntimeUiPlacementResolution[];
  readonly diagnostics: readonly RuntimeUiPlacementDiagnostic[];
}

export interface RuntimeUiPlacementInvokeRequest extends RuntimeUiScope {
  readonly placementId?: string;
  readonly extensionId: string;
  readonly applicationId: string;
  readonly idempotencyKey: string;
  readonly input?: { readonly [key: string]: RuntimeUiJsonValue };
}

export interface RuntimeUiTextContent {
  readonly kind: "text";
  readonly text: string;
}

export interface RuntimeUiMarkdownContent {
  readonly kind: "markdown";
  readonly markdown: string;
}

export interface RuntimeUiApplicationContent {
  readonly kind: "application";
  readonly renderId: string;
  readonly resource: RuntimeUiApplicationResource;
  readonly descriptor: UiApplicationManifest;
  readonly state?: { readonly [key: string]: RuntimeUiJsonValue };
}

export interface RuntimeUiApplicationResource {
  readonly uri: string;
  readonly mimeType: string;
  readonly name?: string;
}

export type RuntimeUiDocumentAnnotationTone = "info" | "positive" | "warning" | "muted";

/** A 1-based line range an extension marks in an open document (gutter mark, label, hover). */
export interface RuntimeUiDocumentAnnotation {
  readonly startLine: number;
  readonly endLine?: number;
  readonly tone: RuntimeUiDocumentAnnotationTone;
  readonly label: string;
  readonly detail?: string;
}

export interface RuntimeUiFileContent {
  readonly kind: "file";
  readonly path: string;
  readonly readCapability?: string;
  /** 1-based line to scroll into view when the document shows. */
  readonly revealLine?: number;
  readonly annotations?: readonly RuntimeUiDocumentAnnotation[];
}

export type RuntimeUiContent =
  | RuntimeUiFileContent
  | RuntimeUiTextContent
  | RuntimeUiMarkdownContent
  | RuntimeUiApplicationContent;

export const MARSHAL_RUNTIME_DEFAULT_WORKSPACE = "marshal" as const;

export interface RuntimeUiScope {
  readonly sessionId?: string;
  readonly workspaceName: string;
  /** Omit for a session-owned surface. Persistent owners never contain a session ID. */
  readonly applicationScope?: "user" | "workspace";
}

export const RUNTIME_UI_USER_SCOPE: RuntimeUiScope = Object.freeze({
  applicationScope: "user",
  workspaceName: MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
});

export function runtimeUiScopeKey(scope: RuntimeUiScope): string {
  return JSON.stringify([
    scope.applicationScope ?? "session",
    scope.sessionId ?? null,
    scope.workspaceName,
  ]);
}

export function runtimeUiScopeOf(scope: RuntimeUiScope): RuntimeUiScope {
  return scope.applicationScope
    ? { applicationScope: scope.applicationScope, workspaceName: scope.workspaceName }
    : { sessionId: scope.sessionId, workspaceName: scope.workspaceName };
}

export interface RuntimeUiOwner extends RuntimeUiScope {
  readonly extensionId: string;
  readonly applicationId: string;
}

export interface RuntimeUiOwnerIdentity {
  readonly extensionId: string;
  readonly applicationId: string;
}

/** Which client surface initiated an open/focus. Server-derived (from the
 *  dispatching sender), never client-claimed. */
export type RuntimeUiClientOrigin = "desktop" | "remote";

export interface RuntimeUiInstanceMetadata {
  readonly instanceId: string;
  readonly owner: RuntimeUiOwner;
  readonly surface: RuntimeUiSurface;
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly focusedAt: string;
  /**
   * The surface whose command produced the CURRENT focusedAt. The desktop
   * navigation only auto-follows desktop-originated focus, so a phone
   * activation renders remotely without hijacking the Mac's window (M2).
   * Absent on instances from older snapshots = desktop.
   */
  readonly focusedBy?: RuntimeUiClientOrigin;
  /** Stable human label for tabs and cards; falls back to the content's name. */
  readonly title?: string;
  /**
   * Present only on transient cards: they float above the chat, never enter
   * the transcript or the saved session, and close on completion (the owner
   * closes them), on user dismissal, or at `expiresAt`.
   */
  readonly transient?: RuntimeUiTransientState;
  /** Where a permanent `inline-card` sits in the transcript. */
  readonly anchor?: RuntimeUiCardAnchor;
}

export interface RuntimeUiTransientState {
  readonly expiresAt?: string;
}

export interface RuntimeUiCardAnchor {
  /** Renders inside the assistant message containing `<!--ui:<slot>-->`. */
  readonly slot?: string;
  /** Renders right after this message instead of at its open time. */
  readonly afterMessageId?: string;
}

/** Open-time transient options; the controller turns `timeoutMs` into `expiresAt`. */
export interface RuntimeUiTransientRequest {
  readonly timeoutMs?: number;
}

export interface RuntimeUiInstance extends RuntimeUiInstanceMetadata {
  readonly content: RuntimeUiContent;
}

export type RuntimeUiPermission =
  | "ui.open"
  | "ui.update"
  | "ui.focus"
  | "ui.close"
  | "ui.list"
  | "ui.snapshot"
  | "ui.notification.show"
  | "ui.chat.message.post"
  | "ui.chat.card.show";

export interface RuntimeUiAuthorityRequest {
  readonly permission: RuntimeUiPermission;
  readonly scope: RuntimeUiScope;
  readonly owner?: RuntimeUiOwnerIdentity;
  readonly instanceId?: string;
}

export type RuntimeUiAuthorityDecision =
  | { readonly allowed: true; readonly scope: RuntimeUiScope }
  | { readonly allowed: false; readonly reason?: string };

export interface RuntimeUiViewOptions {
  readonly title?: string;
  /** Only valid on the `inline-card` surface. */
  readonly transient?: RuntimeUiTransientRequest;
  /** Only valid on a permanent `inline-card`. */
  readonly anchor?: RuntimeUiCardAnchor;
}

export interface RuntimeUiOpenCommand extends RuntimeUiOwner, RuntimeUiViewOptions {
  readonly surface: RuntimeUiSurface;
  readonly content: RuntimeUiContent;
  readonly idempotencyKey: string;
  /** Server-derived dispatching surface; the IPC layer overrides any
   *  client-supplied value. */
  readonly origin?: RuntimeUiClientOrigin;
  /**
   * Swap this open view's content in place instead of opening a new one: the
   * view keeps its id, placement, and transcript position. The replaced view
   * must belong to the same extension and scope.
   */
  readonly replaceInstanceId?: string;
}

export interface RuntimeUiUpdateCommand extends RuntimeUiOwner {
  readonly instanceId: string;
  readonly content: RuntimeUiContent;
  readonly idempotencyKey: string;
}

export interface RuntimeUiFocusCommand extends RuntimeUiOwner {
  readonly instanceId: string;
  readonly idempotencyKey: string;
  /** Moves the instance onto this surface while focusing it. */
  readonly surface?: RuntimeUiSurface;
  /**
   * Record a move the user already made (a drag in the dock layout) without
   * re-focusing: emits `instance-updated` and keeps `focusedAt`.
   */
  readonly preserveFocus?: boolean;
  /** Server-derived dispatching surface; the IPC layer overrides any
   *  client-supplied value. */
  readonly origin?: RuntimeUiClientOrigin;
}

export interface RuntimeUiCloseCommand extends RuntimeUiOwner {
  readonly instanceId: string;
  readonly idempotencyKey: string;
}

export interface RuntimeUiListCommand extends RuntimeUiScope {
  readonly owner?: RuntimeUiOwnerIdentity;
  readonly surface?: RuntimeUiSurface;
}

export interface RuntimeUiApplicationHostCommand extends RuntimeUiOwner {
  readonly instanceId: string;
}

export interface RuntimeUiSelectedSession {
  readonly grantId: string;
  readonly workspaceName?: string;
  readonly sessionId: string;
  readonly title?: string;
}

export interface RuntimeUiSessionSearchRequest extends RuntimeUiApplicationHostCommand {
  readonly query?: string;
  readonly limit?: number;
}

export interface RuntimeUiSessionSearchResult {
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt?: string;
}

export interface RuntimeUiSelectSessionCommand extends RuntimeUiApplicationHostCommand {
  readonly targetSessionId?: string;
}

export type RuntimeUiImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface RuntimeUiImageHandle {
  readonly handle: string;
  readonly mimeType: RuntimeUiImageMimeType;
  readonly displayName: string;
  readonly byteLength: number;
  readonly expiresAt: string;
}

export interface RuntimeUiImageCommand extends RuntimeUiApplicationHostCommand {
  readonly handle: string;
}

export interface RuntimeUiImageContent {
  readonly mimeType: RuntimeUiImageMimeType;
  readonly data: string;
}

export interface RuntimeUiApplicationCapabilityInvokeCommand extends RuntimeUiApplicationHostCommand {
  readonly publicationRevisionId?: string;
  readonly capability: string;
  readonly input?: unknown;
  readonly idempotencyKey: string;
}

export interface RuntimeUiApplicationCapabilityCancelCommand extends RuntimeUiApplicationHostCommand {
  readonly idempotencyKey: string;
}

export interface RuntimeUiApplicationResourceReadCommand extends RuntimeUiApplicationHostCommand {
  readonly uri: string;
}

export interface RuntimeUiApplicationCapabilityValue {
  readonly output: unknown;
}

export interface RuntimeUiApplicationResourceContent {
  readonly revisionId?: string;
  readonly integrity?: string;
  readonly uri: string;
  readonly mimeType: string;
  readonly name?: string;
  readonly text?: string;
  /**
   * Declared client viewports from the publication's metadata
   * (marshal.ui.viewports). Absent = undeclared: session-owned renders gate to
   * desktop-only (see common/runtime-ui-viewports.ts).
   */
  readonly viewports?: readonly MarshalUiViewport[];
}

/**
 * Host callbacks exposed to an application renderer. The renderer is kept
 * independent from Electron and receives only the owning instance scope.
 */
export interface RuntimeUiApplicationHost {
  readonly selectedSession?: RuntimeUiSelectedSession | null;
  readonly searchSessions?: (
    query: string,
    limit?: number,
  ) => Promise<readonly RuntimeUiSessionSearchResult[]>;
  readonly selectSession?: (targetSessionId?: string) => Promise<RuntimeUiSelectedSession | null>;
  readonly getSelectedSession?: () => Promise<RuntimeUiSelectedSession | null>;
  readonly selectedImages?: readonly RuntimeUiImageHandle[];
  readonly readImage?: (
    handle: string,
  ) => Promise<{ readonly mimeType: string; readonly data: string }>;
  readonly instance: RuntimeUiInstance;
  readonly invokeCapability: (
    request: Omit<
      RuntimeUiApplicationCapabilityInvokeCommand,
      keyof RuntimeUiApplicationHostCommand
    >,
  ) => Promise<RuntimeUiApplicationCapabilityValue>;
  readonly cancelCapability?: (idempotencyKey: string) => Promise<void>;
  readonly readResource: (uri: string) => Promise<RuntimeUiApplicationResourceContent>;
  readonly subscribe: (listener: (event: RuntimeUiEvent) => void) => () => void;
  readonly focus: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly update: (state: { readonly [key: string]: RuntimeUiJsonValue }) => Promise<void>;
}

export interface RuntimeUiNotificationCommand extends RuntimeUiOwner {
  readonly title: string;
  readonly message: string;
  readonly idempotencyKey: string;
}

export interface RuntimeUiChatMessageCommand extends RuntimeUiOwner {
  readonly content: RuntimeUiTextContent | RuntimeUiMarkdownContent;
  readonly idempotencyKey: string;
}

export interface RuntimeUiChatCardCommand extends RuntimeUiOwner, RuntimeUiViewOptions {
  readonly content: RuntimeUiContent;
  readonly idempotencyKey: string;
}

export type RuntimeUiCommand =
  | { readonly action: "open"; readonly request: RuntimeUiOpenCommand }
  | { readonly action: "update"; readonly request: RuntimeUiUpdateCommand }
  | { readonly action: "focus"; readonly request: RuntimeUiFocusCommand }
  | { readonly action: "close"; readonly request: RuntimeUiCloseCommand }
  | { readonly action: "list"; readonly request: RuntimeUiListCommand }
  | { readonly action: "notification.show"; readonly request: RuntimeUiNotificationCommand }
  | { readonly action: "chat.message.post"; readonly request: RuntimeUiChatMessageCommand }
  | { readonly action: "chat.card.show"; readonly request: RuntimeUiChatCardCommand };

export type RuntimeUiAction =
  | "open"
  | "update"
  | "focus"
  | "close"
  | "list"
  | "notification.show"
  | "chat.message.post"
  | "chat.card.show";

export interface RuntimeUiCommandReceipt {
  readonly receiptId: string;
  readonly action: RuntimeUiAction;
  readonly status: "applied" | "deduplicated";
  readonly completedAt: string;
  readonly revision: number;
  readonly instanceId?: string;
  readonly deliveryId?: string;
}

export interface RuntimeUiCommandResult {
  readonly receipt: RuntimeUiCommandReceipt;
  readonly instance?: RuntimeUiInstance;
  readonly instances?: readonly RuntimeUiInstance[];
}

interface RuntimeUiEventBase {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly scope: RuntimeUiScope;
}

export type RuntimeUiEvent =
  | (RuntimeUiEventBase & {
      readonly type: "instance-opened";
      readonly instance: RuntimeUiInstance;
    })
  | (RuntimeUiEventBase & {
      readonly type: "instance-updated";
      readonly instance: RuntimeUiInstance;
    })
  | (RuntimeUiEventBase & {
      readonly type: "instance-focused";
      readonly instance: RuntimeUiInstance;
    })
  | (RuntimeUiEventBase & {
      readonly type: "instance-closed";
      readonly instanceId: string;
      readonly owner: RuntimeUiOwner;
      readonly reason: "command" | "owner-invalidated" | "expired";
    })
  | (RuntimeUiEventBase & {
      readonly type: "owner-invalidated";
      readonly owner: RuntimeUiOwnerIdentity;
      readonly closedInstanceIds: readonly string[];
    })
  | (RuntimeUiEventBase & {
      readonly type: "delivery-succeeded";
      readonly owner: RuntimeUiOwner;
      readonly delivery: "notification" | "chat-message" | "chat-card";
      readonly deliveryId: string;
    })
  | (RuntimeUiEventBase & {
      readonly type: "delivery-stream";
      readonly owner: RuntimeUiOwner;
      /** The namespaced outbound request id the chunk belongs to. */
      readonly requestId: string;
      /** Strictly increasing per requestId; independent of the global event sequence. */
      readonly streamSequence: number;
      readonly chunk: RuntimeUiDeliveryStreamChunk;
      /** Exactly one terminal event concludes each delivery's stream. */
      readonly terminal: boolean;
      readonly terminalState?: string;
    });

/**
 * One bounded progressive-answer fragment of a session delivery (CF-05 live
 * streaming). Push-only: stream events are never recorded into snapshot
 * history — a consumer that needs the authoritative final state reconciles
 * through the delivery read capability it already uses.
 */
export interface RuntimeUiDeliveryStreamChunk {
  readonly kind: "text" | "status" | "retry" | "error";
  readonly text?: string;
}

export interface RuntimeUiSnapshot {
  readonly revision: number;
  readonly generatedAt: string;
  readonly scope: RuntimeUiScope;
  readonly instances: readonly RuntimeUiInstance[];
  readonly events: readonly RuntimeUiEvent[];
}

export type RuntimeUiErrorCode =
  | "approval-required"
  | "cancelled"
  | "aborted"
  | "idempotency-capacity"
  | "idempotency-conflict"
  | "invalid-request"
  | "not-found"
  | "operation-failed"
  | "permission-denied"
  | "runtime-unavailable";

export interface RuntimeUiError {
  readonly code: RuntimeUiErrorCode;
  readonly message: string;
}

export type RuntimeUiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RuntimeUiError };

export type RuntimeUiIpcResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly error: RuntimeUiError };

/** Durable extension evidence is queried from each application's authoritative provider. */
export interface RuntimeUiEvidenceEntry extends RuntimeUiOwner {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly applicationTitle: string;
}
export interface RuntimeUiEvidenceOpenRequest extends RuntimeUiOwner {
  /** The host renders this evidence within the existing progress panel. */
  readonly presentation?: "embedded";
  readonly id: string;
  readonly idempotencyKey: string;
}
