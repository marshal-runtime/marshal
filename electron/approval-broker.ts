import type { PermissionAction } from "../common/marshal-constants";
import type { WorkspaceInstanceIdentity } from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import { workspaceInstanceIdentitiesEqual } from "../common/workspace-role-identity";
import type { IApprovalBroker } from "./backend/ports";
import type { ApprovalRequest } from "./backend/types";
import type { CommandClassification } from "./permission-classification-contracts";

const log = createLogger("ApprovalBroker");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BrokerRequest {
  /**
   * Original permission request — the broker never reads this. It is carried
   * through as opaque context for two consumers:
   *  - The adapter reads it after `requestPrompt` resolves to call
   *    `policy.recordInteractiveOutcome(permissionRequest, action, sdkResult)`.
   *  - The card manager reads it in `handlePending` for `formatPermissionDialog`,
   *    tooltip computation, and `kind`/`toolCallId`/`sessionId` display fields.
   */
  permissionRequest: ApprovalRequest;
  /** Unique ID for this prompt (perm-{ts}-{rand}). */
  requestId: string;
  /** Session this request belongs to (convenience alias for permissionRequest.sessionId). */
  sessionId: string;
  /** Optional pre-computed LLM classification. Callers that can afford the async
   *  cost provide it; the card manager uses classification.explanation in place
   *  of the generic formatted message and threads category/pattern into the card. */
  classification?: CommandClassification;
}

export type PromptResult =
  | {
      outcome: "resolved";
      action: PermissionAction;
      /** True when the resolution came from an auto-resolve path (e.g.,
       *  `resolveSilent` from the burst defuser). The adapter uses this to
       *  skip `recordInteractiveOutcome` so we don't write a misleading
       *  `user-interactive` audit row for a click the user never made. */
      silent?: boolean;
    }
  | { outcome: "timed-out" };

export interface TransientApprovalBinding {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly workspaceIdentity: WorkspaceInstanceIdentity;
  readonly capability: string;
  readonly permissions: readonly string[];
  readonly requestDigest: string;
}

export type TransientApprovalStatus = "pending" | "approved" | "denied" | "expired" | "missing";

export type TransientApprovalConsumeResult =
  | { readonly status: "approved"; readonly permissions: readonly string[] }
  | { readonly status: Exclude<TransientApprovalStatus, "approved"> | "mismatch" };

export interface TransientApprovalPrompt {
  readonly binding: TransientApprovalBinding;
  readonly expiresAt: number;
  readonly onResolution: (action: PermissionAction) => boolean;
  readonly onTimeout?: () => void;
  readonly onCancel?: () => void;
}

export interface TransientApprovalPromptResult {
  readonly requestId: string;
  readonly expiresAt: number;
  readonly created: boolean;
}

interface PendingPrompt {
  readonly resolve: (result: PromptResult) => void;
  readonly timeoutId: ReturnType<typeof setTimeout>;
  readonly sessionId: string;
  readonly permissionRequest: ApprovalRequest;
  readonly transient?: TransientApprovalPrompt;
}

interface TransientResolution {
  readonly binding: TransientApprovalBinding;
  readonly approved: boolean;
  readonly expiresAt: number;
}

export interface ApprovalListener {
  /** Fired when a prompt is created (blocking Promise started). */
  onPending?: (request: BrokerRequest) => void;
  /** Fired when a prompt is resolved by user action or clearSession. */
  onResolved?: (requestId: string, action: PermissionAction) => void;
  /** Fired when a prompt times out (auto-deny). Fires BEFORE the Promise resolves. */
  onTimeout?: (requestId: string) => void;
  /**
   * Fired when an async classifier reports a result for an already-pending
   * prompt. Adapter calls `reportClassification` after the card has been
   * shown; card manager uses this to patch the pending card with a secondary
   * "Allow broader pattern" suggestion. Never fires if the prompt has already
   * resolved.
   */
  onClassification?: (requestId: string, classification: CommandClassification) => void;
}

// ── ApprovalBroker ────────────────────────────────────────────────────────────

/**
 * Pure prompt mechanism — owns the blocking Promise that the SDK waits on,
 * the auto-deny timeout, and event emission.
 *
 * Does NOT evaluate policy or record outcomes. Those responsibilities live
 * in the adapter (CopilotBackend path) or in DesktopCapabilities
 * (GatewayBackend Phase 2 path), making the broker genuinely shared
 * infrastructure.
 */
export class ApprovalBroker implements IApprovalBroker {
  /**
   * Default auto-deny timeout for a pending permission prompt. Exposed as a
   * static property so docs and tests can reference it by name rather than
   * hardcoding the number — the actual value is a stopgap while we decide
   * whether to drop auto-deny entirely.
   */
  static readonly DEFAULT_TIMEOUT_MS = 48 * 60 * 60 * 1000; // 48 hours
  static readonly MAX_TRANSIENT_RESOLUTIONS = 128;

  private pending = new Map<string, PendingPrompt>();
  private transientResolutions = new Map<string, TransientResolution>();
  private listeners = new Set<Partial<ApprovalListener>>();
  private timeoutMs: number;

  constructor(timeoutMs?: number) {
    this.timeoutMs = timeoutMs ?? ApprovalBroker.DEFAULT_TIMEOUT_MS;
  }

  /**
   * Create a blocking prompt. Returns when the user responds or the timeout
   * fires. The caller decides what to do with the result.
   */
  requestPrompt(request: BrokerRequest): Promise<PromptResult> {
    return this.openPrompt(request);
  }

  /**
   * Open the existing permission card without waiting for a person to respond.
   * The resolved decision is retained briefly for one exact, explicit retry.
   */
  requestTransientPrompt(
    request: BrokerRequest,
    transient: TransientApprovalPrompt,
  ): TransientApprovalPromptResult {
    for (const [requestId, entry] of this.pending) {
      if (entry.transient && sameTransientBinding(entry.transient.binding, transient.binding)) {
        return {
          requestId,
          expiresAt: entry.transient.expiresAt,
          created: false,
        };
      }
    }
    void this.openPrompt(request, transient);
    return {
      requestId: request.requestId,
      expiresAt: transient.expiresAt,
      created: true,
    };
  }

  private openPrompt(
    request: BrokerRequest,
    transient?: TransientApprovalPrompt,
  ): Promise<PromptResult> {
    // Guard: if this requestId is already pending, deny it to prevent timer leaks
    const existing = this.pending.get(request.requestId);
    if (existing) {
      this.settle(request.requestId, existing, "deny");
    }
    this.transientResolutions.delete(request.requestId);

    return new Promise<PromptResult>((resolve) => {
      const timeoutMs = transient
        ? Math.min(this.timeoutMs, Math.max(1, transient.expiresAt - Date.now()))
        : this.timeoutMs;
      const timeoutId = setTimeout(() => {
        const entry = this.pending.get(request.requestId);
        if (!entry) return;
        this.pending.delete(request.requestId);
        entry.transient?.onTimeout?.();
        if (entry.transient) {
          this.rememberTransient(request.requestId, entry.transient, false);
        }
        this.emitTimeout(request.requestId);
        resolve({ outcome: "timed-out" });
      }, timeoutMs);

      this.pending.set(request.requestId, {
        resolve,
        timeoutId,
        sessionId: request.sessionId,
        permissionRequest: request.permissionRequest,
        ...(transient ? { transient } : {}),
      });

      this.emitPending(request);
    });
  }

  /**
   * Resolve a pending prompt with the user's action. Returns false if the
   * requestId is unknown or already resolved/timed out.
   */
  resolve(requestId: string, action: PermissionAction): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    this.settle(requestId, entry, action);
    return true;
  }

  /**
   * Resolve a pending prompt without attributing the decision to a user
   * click. Used by the burst defuser to auto-approve sibling tool calls
   * after one always-allow click. Same wire effect as {@link resolve} —
   * `onResolved` still fires (so card UI cleans up) — but the awaiting
   * adapter sees `silent: true` and skips `recordInteractiveOutcome`,
   * leaving the audit trail to a single dedicated `policy-burst-defuser`
   * entry emitted by the policy.
   */
  resolveSilent(requestId: string, action: PermissionAction): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (entry.transient) return false;

    clearTimeout(entry.timeoutId);
    this.pending.delete(requestId);
    this.emitResolved(requestId, action);
    entry.resolve({ outcome: "resolved", action, silent: true });
    return true;
  }

  /** Check if a prompt is still pending. */
  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Return the original ApprovalRequest for a pending prompt, or null if
   * the prompt has already resolved. Used by the resolve IPC handler so it
   * can re-run guardrails on an overridePattern before mutating
   * `approvalPattern` and invoking the final resolve flow.
   */
  getPendingRequest(requestId: string): ApprovalRequest | null {
    return this.pending.get(requestId)?.permissionRequest ?? null;
  }

  /**
   * List all currently pending prompts, optionally scoped to a single session.
   * Used by `PermissionCardManager`'s burst defuser to auto-resolve siblings
   * in a parallel tool burst after one card grants always-allow.
   */
  listPendingRequests(
    sessionId?: string,
  ): { requestId: string; permissionRequest: ApprovalRequest }[] {
    const out: { requestId: string; permissionRequest: ApprovalRequest }[] = [];
    for (const [requestId, entry] of this.pending) {
      if (sessionId && entry.sessionId !== sessionId) continue;
      if (entry.transient) continue;
      out.push({ requestId, permissionRequest: entry.permissionRequest });
    }
    return out;
  }

  transientApprovalStatus(requestId: string): TransientApprovalStatus {
    const pending = this.pending.get(requestId);
    if (pending?.transient) return "pending";
    const resolution = this.transientResolutions.get(requestId);
    if (!resolution) return "missing";
    if (resolution.expiresAt <= Date.now()) {
      this.transientResolutions.delete(requestId);
      return "expired";
    }
    return resolution.approved ? "approved" : "denied";
  }

  consumeTransientApproval(
    requestId: string,
    binding: TransientApprovalBinding,
  ): TransientApprovalConsumeResult {
    const status = this.transientApprovalStatus(requestId);
    if (status !== "approved" && status !== "denied") return { status };
    const resolution = this.transientResolutions.get(requestId);
    if (!resolution) return { status: "missing" };
    this.transientResolutions.delete(requestId);
    if (!sameTransientBinding(resolution.binding, binding)) {
      return { status: "mismatch" };
    }
    return resolution.approved
      ? { status: "approved", permissions: resolution.binding.permissions }
      : { status: "denied" };
  }

  cancelTransientApproval(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    if (pending?.transient) {
      clearTimeout(pending.timeoutId);
      this.pending.delete(requestId);
      pending.transient.onCancel?.();
      this.emitResolved(requestId, "deny");
      pending.resolve({ outcome: "resolved", action: "deny" });
      return true;
    }
    return this.transientResolutions.delete(requestId);
  }

  /**
   * Push a classification result for an already-pending prompt. Used by the
   * adapter to decouple the async classifier from card rendering: the card
   * appears synchronously at t=0 with a heuristic primary, and the LLM's
   * (possibly broader) suggestion arrives later as a secondary. Silently
   * drops if the prompt is no longer pending.
   */
  reportClassification(requestId: string, classification: CommandClassification): void {
    if (!this.pending.has(requestId)) return;
    this.emitClassification(requestId, classification);
  }

  /** Subscribe to broker events. Returns an unsubscribe function. */
  subscribe(listener: Partial<ApprovalListener>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Drain all pending prompts for a session (deny each). */
  clearSession(sessionId: string): void {
    const entries = [...this.pending.entries()].filter(([, e]) => e.sessionId === sessionId);
    for (const [requestId] of entries) this.pending.delete(requestId);
    for (const [requestId, entry] of entries) {
      clearTimeout(entry.timeoutId);
      entry.transient?.onCancel?.();
      this.emitResolved(requestId, "deny");
      entry.resolve({ outcome: "resolved", action: "deny" });
    }
    for (const [requestId, resolution] of this.transientResolutions) {
      if (resolution.binding.sessionId === sessionId) {
        this.transientResolutions.delete(requestId);
      }
    }
  }

  /**
   * Drain ALL pending prompts across all sessions.
   *
   * Intended for app shutdown (`before-quit`). Defaults to "deny" because
   * draining is not a user decision — using "always-allow" would persist
   * approval patterns the user never actually granted. The adapter's
   * `recordInteractiveOutcome("deny")` is a no-op (no disk write), so
   * shutdown draining has no side effects beyond the best-effort audit log.
   *
   * Invariant: `hasPending(id)` returns false inside `onResolved` listeners,
   * consistent with `resolve()`.
   */
  drainAll(action: PermissionAction = "deny"): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [requestId, entry] of entries) {
      clearTimeout(entry.timeoutId);
      entry.transient?.onCancel?.();
      this.emitResolved(requestId, action);
      entry.resolve({ outcome: "resolved", action });
    }
    this.transientResolutions.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private settle(requestId: string, entry: PendingPrompt, action: PermissionAction): void {
    clearTimeout(entry.timeoutId);
    this.pending.delete(requestId);
    if (entry.transient) {
      let approved = false;
      try {
        approved = entry.transient.onResolution(action);
      } catch (error) {
        log.error("Transient approval resolution failed:", error);
      }
      this.rememberTransient(requestId, entry.transient, approved);
    }
    this.emitResolved(requestId, action);
    entry.resolve({ outcome: "resolved", action });
  }

  private rememberTransient(
    requestId: string,
    transient: TransientApprovalPrompt,
    approved: boolean,
  ): void {
    this.pruneTransientResolutions();
    while (this.transientResolutions.size >= ApprovalBroker.MAX_TRANSIENT_RESOLUTIONS) {
      const oldest = this.transientResolutions.keys().next().value;
      if (!oldest) break;
      this.transientResolutions.delete(oldest);
    }
    this.transientResolutions.set(requestId, {
      binding: transient.binding,
      approved,
      expiresAt: transient.expiresAt,
    });
  }

  private pruneTransientResolutions(): void {
    const now = Date.now();
    for (const [requestId, resolution] of this.transientResolutions) {
      if (resolution.expiresAt <= now) this.transientResolutions.delete(requestId);
    }
  }

  private emitPending(request: BrokerRequest): void {
    for (const listener of this.listeners) {
      try {
        listener.onPending?.(request);
      } catch (err) {
        log.error("Listener error in onPending:", err);
      }
    }
  }

  private emitResolved(requestId: string, action: PermissionAction): void {
    for (const listener of this.listeners) {
      try {
        listener.onResolved?.(requestId, action);
      } catch (err) {
        log.error("Listener error in onResolved:", err);
      }
    }
  }

  private emitTimeout(requestId: string): void {
    for (const listener of this.listeners) {
      try {
        listener.onTimeout?.(requestId);
      } catch (err) {
        log.error("Listener error in onTimeout:", err);
      }
    }
  }

  private emitClassification(requestId: string, classification: CommandClassification): void {
    for (const listener of this.listeners) {
      try {
        listener.onClassification?.(requestId, classification);
      } catch (err) {
        log.error("Listener error in onClassification:", err);
      }
    }
  }
}

function sameTransientBinding(
  left: TransientApprovalBinding,
  right: TransientApprovalBinding,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.workspacePath === right.workspacePath &&
    workspaceInstanceIdentitiesEqual(left.workspaceIdentity, right.workspaceIdentity) &&
    left.capability === right.capability &&
    left.requestDigest === right.requestDigest &&
    left.permissions.length === right.permissions.length &&
    left.permissions.every((permission, index) => permission === right.permissions[index])
  );
}
