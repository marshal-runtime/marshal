import type { BrowserWindow } from "electron";

import type { PermissionAction } from "../common/marshal-constants";
import type { PermissionCardData, TurnEvent } from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import type { ApprovalBroker, BrokerRequest } from "./approval-broker";
import type { ApprovalRequest } from "./backend/types";
import { isBrowserUsePermission } from "./browser-use-permission-classifier";
import type { CommandClassification } from "./permission-classification-contracts";
import { externalPermissionPrompt } from "./permission-external-redaction";
import { applyGuardrails } from "./permission-pattern-guardrails";
import { extractPattern } from "./permission-patterns";
import { getCommandText, isReadOnlyCommand } from "./permission-policy";
import type { PermissionPolicy } from "./permission-policy";
import { formatPermissionDialog, truncateMiddle } from "./permissions";
import type { SessionManager } from "./sessions";

const log = createLogger("PermissionCardManager");

interface SdkPromptMetadata {
  intention?: string;
  warning?: string;
  commandIdentifiers: string[];
}

const EMPTY_SDK_PROMPT_METADATA: SdkPromptMetadata = { commandIdentifiers: [] };

function extractSdkPromptMetadata(request: ApprovalRequest): SdkPromptMetadata {
  if (request.kind === "shell" || request.kind === "custom-tool") {
    return {
      intention: request.intention,
      warning: request.warning,
      commandIdentifiers: request.commandIdentifiers,
    };
  }
  return {
    intention: undefined,
    warning: undefined,
    commandIdentifiers: [],
  };
}

/**
 * Button set for a permission card. `settings` cards are a fixed Allow/Deny;
 * everything else offers the persistence ladder when the request can be
 * persisted.
 */
function cardButtonsFor(permReq: ApprovalRequest, canPersist: boolean): string[] {
  if (permReq.kind === "settings") return ["Allow", "Deny"];
  if (canPersist) return ["Allow", "Allow for session", "Always allow", "Deny"];
  return ["Allow", "Allow for session", "Deny"];
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingPermissionPrompt {
  id: string;
  toolCallId?: string;
  sessionId?: string;
  kind: PermissionCardData["kind"];
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  tooltips?: Record<string, string>;
  category?: "readonly" | "writes" | "network" | "destructive" | "unknown";
  suggestedPattern?: string | null;
  patternRationale?: string | null;
  sdkIntention?: string;
  sdkWarning?: string;
  sdkCommandIdentifiers?: string[];
  sdkCanOfferSessionApproval?: boolean;
  browserUseDisclosure?: boolean;
  primaryPattern?: string | null;
  canPersistAlwaysAllow?: boolean;
  sensitivePathWarning?: string;
  /** Quotes the memory being erased; redacted on every surface outside the app. */
  isForgetCompletely?: boolean;
}

export interface PermissionHandlerCallbacks {
  /** Called when a permission card is shown (e.g., to notify mini-mode). */
  onApprovalRequested?: (request: PendingPermissionPrompt) => void;
  /** Called when a permission is resolved or timed out (e.g., to hide mini-mode / clean up relay). */
  onPermissionResolved?: (requestId: string) => void;
  /** Called when a permission requires interactive approval (e.g., to mirror onto a messaging relay). */
  onPrompt?: (
    title: string,
    message: string,
    detail: string,
    requestId: string,
    sessionId?: string,
    tooltips?: Record<string, string>,
    buttons?: string[],
  ) => void;
  /** When true, permissions are handled by a messaging relay — skip desktop UI. */
  isRelayHandled?: (sessionId?: string) => boolean;
}

/**
 * UI projection of permission card state. Subscribes to `ApprovalBroker`
 * events to create and update cards. Owns all presentation concerns:
 * dialog formatting, tooltip computation, button layout.
 *
 * The broker carries only identity + an optional LLM explanation hint.
 * This class turns that into a full permission card with human-readable
 * text, buttons, and tooltips. Both CopilotBackend (via adapter) and
 * GatewayBackend (via DesktopCapabilities) get identical card UI
 * without duplicating formatting logic.
 */
export class PermissionCardManager {
  // ── Card state ────────────────────────────────────────────────────────
  private cards = new Map<string, PermissionCardData[]>();

  // ── Dependencies ──────────────────────────────────────────────────────
  private onCardsChanged?: (payload: { sessionId: string; cards: PermissionCardData[] }) => void;
  private getWindow: () => BrowserWindow | null;
  private sessionManager: SessionManager;
  private workspaceDir: string | undefined;
  private broker: ApprovalBroker | null = null;
  private policy: PermissionPolicy | null = null;
  private callbacks: PermissionHandlerCallbacks = {};
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeBroker: (() => void) | null = null;

  constructor(deps: {
    onCardsChanged?: (payload: { sessionId: string; cards: PermissionCardData[] }) => void;
    getWindow: () => BrowserWindow | null;
    sessionManager: SessionManager;
    workspaceDir?: string;
  }) {
    this.onCardsChanged = deps.onCardsChanged;
    this.getWindow = deps.getWindow;
    this.sessionManager = deps.sessionManager;
    this.workspaceDir = deps.workspaceDir;
  }

  /** Connect to the approval broker and subscribe to its events. */
  connectBroker(broker: ApprovalBroker): void {
    this.unsubscribeBroker?.();
    this.broker = broker;
    this.unsubscribeBroker = broker.subscribe({
      onPending: (request) => {
        this.handlePending(request).catch((err) => {
          log.error("[PermissionCardManager] handlePending failed, showing fallback card:", err);

          // After async failure, request may have been resolved/timed out
          if (!this.broker?.hasPending(request.requestId)) return;

          this.presentCard(
            request,
            "🔐 Permission Needed",
            `Marshal wants to perform an action`,
            "",
          );
        });
      },
      onResolved: (requestId, action) => {
        this.respondCard(requestId, action);
        this.callbacks.onPermissionResolved?.(requestId);
      },
      onTimeout: (requestId) => {
        this.timeoutCard(requestId);
        this.callbacks.onPermissionResolved?.(requestId);
      },
      onClassification: (requestId, classification) =>
        this.updateClassification(requestId, classification),
    });
  }

  /**
   * Connect to the permission policy and wire the burst-defuser hook.
   * After the policy persists a new always-allow rule, this manager will
   * re-evaluate every pending permission request scoped to the originating
   * session and silently resolve the siblings that the new rule now
   * approves — so a parallel tool burst (e.g., 18 simultaneous
   * `moveEmail` calls) unblocks from a single user click.
   *
   * Singleton-by-design: the underlying `setOnAlwaysAllowAdded` throws on
   * a second registration, so a second `connectPolicy` call would fail
   * loudly rather than silently displace the first wiring.
   */
  connectPolicy(policy: PermissionPolicy): void {
    this.policy = policy;
    policy.setOnAlwaysAllowAdded((sessionId) => this.defuseBurst(sessionId));
  }

  /** Set callbacks for external notification (mini-mode, relay). */
  setCallbacks(callbacks: PermissionHandlerCallbacks): void {
    this.callbacks = callbacks;
  }

  /** Subscribe to TurnEvents for tool completion, error, and idle. */
  start(): void {
    this.unsubscribeEvents = this.sessionManager.addEventListener(
      (sessionId: string, event: TurnEvent) => {
        if (event.type === "turn:tool-completed") {
          this.toolComplete(event.toolCallId, event.output, event.success);
        } else if (event.type === "turn:error" || event.type === "turn:idle") {
          this.resolveStuck(sessionId);
        }
      },
    );
  }

  /** Unsubscribe from SDK events and broker. */
  dispose(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.unsubscribeBroker?.();
    this.unsubscribeBroker = null;
  }

  // ── Resolve / Query ─────────────────────────────────────────────────────

  /**
   * Deliver the user's Allow/Deny choice. Delegates to the broker to
   * unblock the SDK-blocking Promise. Card state updates happen via
   * the broker's onResolved event subscriber.
   *
   * When `overridePattern` is set (user clicked the "Allow broader pattern"
   * secondary), the pattern is re-run through guardrails here before being
   * written to `request.approvalPattern`. The renderer CANNOT be trusted to
   * present a safe pattern — this is the defence-in-depth boundary for any
   * classifier/user-typed override. If guardrails null the override, the
   * primary (sync heuristic) is preserved untouched.
   */
  resolve(
    requestId: string,
    action: PermissionAction,
    overridePattern?: string,
  ): { success: boolean } {
    if (!this.broker) {
      this.respondFailed(requestId);
      return { success: false };
    }
    if (overridePattern) {
      this.applyOverridePattern(requestId, overridePattern);
    }
    const success = this.broker.resolve(requestId, action);
    if (!success) {
      // Promise already resolved (timeout or another client) — mark card as failed
      this.respondFailed(requestId);
    }
    return { success };
  }

  /**
   * Re-run the heuristic guardrails on a caller-supplied pattern and write
   * it to `request.approvalPattern` when it survives. No-op if the request
   * has already resolved or isn't a shell kind. If guardrails reject the
   * override, the pre-existing primary (set synchronously by the adapter)
   * remains in place.
   *
   * Threads the card's previously-assigned category (from the classifier
   * or adapter heuristic) through to guardrails so the destructive/network
   * category gates still fire against an adversarial renderer-supplied
   * override. Passing `"unknown"` unconditionally would let a destructive
   * command through G_CATEGORY_DESTRUCTIVE via the override path.
   */
  private applyOverridePattern(requestId: string, overridePattern: string): void {
    const pendingRequest = this.broker?.getPendingRequest(requestId);
    if (!pendingRequest) return;
    if (pendingRequest.kind !== "shell") return;
    const command = getCommandText(pendingRequest);
    if (!command) return;
    // No card → can't re-run category guardrails honestly; refuse the override.
    const loc = this.findByRequestId(requestId);
    if (!loc) return;
    const card = this.cards.get(loc.sessionId)![loc.index];
    const gated = applyGuardrails(
      command,
      {
        explanation: "",
        category: card.category ?? "unknown",
        suggestedPattern: overridePattern,
        patternRationale: null,
        source: "llm",
        guardrailRuleId: null,
      },
      { isReadOnlyCommand },
    );
    // Defensive: bare "*" is already nulled by G_BARE_STAR, but re-check so
    // a padded-star escape (e.g. " * ") can't sneak through if guardrails
    // evolve. `gated.suggestedPattern` may be null (guardrail rejected).
    if (gated.suggestedPattern && gated.suggestedPattern.trim() !== "*") {
      pendingRequest.approvalPattern = gated.suggestedPattern;
    }
    // Else: guardrails rejected the override (e.g. bare "*"). Leave the
    // primary approvalPattern alone — safer than writing a forbidden rule.
  }

  /** Returns true if a permission prompt with the given requestId is still pending. */
  hasPending(requestId: string): boolean {
    return this.broker?.hasPending(requestId) ?? false;
  }

  /**
   * Re-evaluate every pending permission request scoped to a session and
   * auto-resolve any whose decision is now `"approve"`. Called after a
   * persistAllowRule write, or after a global policy change such as enabling
   * Autopilot, so already-pending prompts disappear once policy allows them.
   * Requests still evaluating to `"prompt"` or `"deny"` are left untouched.
   *
   * Auto-resolved prompts are settled via `broker.resolveSilent`, which
   * tells the awaiting adapter to skip its `user-interactive` audit row.
   * The helper emits one policy audit row per resolved prompt according to
   * the supplied audit mode.
   *
   * When a sessionId is provided, resolution is scoped to that session so
   * entity-scoped rules can't leak to other sessions. Global policy changes
   * intentionally call this without a sessionId.
   */
  private defuseBurst(sessionId: string): void {
    this.resolvePolicyApprovedPending(sessionId, "burst");
  }

  /** Resolve pending prompts that the current policy now approves. */
  resolvePolicyApprovedPending(
    sessionId?: string,
    auditMode: "policy-update" | "burst" = "policy-update",
  ): number {
    if (!this.broker || !this.policy) return 0;
    const pending = this.broker.listPendingRequests(sessionId);
    let resolved = 0;
    for (const { requestId, permissionRequest } of pending) {
      // Settings cards (permission escalation, forget completely) always need the click.
      if (permissionRequest.kind === "settings") continue;
      if (this.policy.evaluateSilent(permissionRequest) !== "approve") continue;
      // Use action="allow" (not "always-allow"): the rule has already been
      // persisted by the originating click. Re-entering persistAllowRule
      // here would extract a pattern from this sibling's command (which
      // may differ from the user-approved pattern) and write a second rule.
      //
      // Record the audit row only AFTER resolveSilent succeeds — otherwise
      // we'd log a request that raced away (resolved/timed out
      // between listPendingRequests and resolveSilent).
      if (this.broker.resolveSilent(requestId, "allow")) {
        if (auditMode === "burst") {
          this.policy.recordAutoResolvedSibling(permissionRequest);
        } else {
          this.policy.recordAutoApprovedByPolicy(permissionRequest);
        }
        resolved++;
      }
    }
    if (resolved > 0) {
      log.info(
        `Auto-resolved ${resolved} pending permission(s)${sessionId ? ` in session ${sessionId}` : ""} after policy update`,
      );
    }
    return resolved;
  }

  getCards(sessionId: string): PermissionCardData[] {
    return this.cards.get(sessionId) ?? [];
  }

  // ── Card transitions ────────────────────────────────────────────────────

  /** Create a new permission card from a pending prompt. */
  addCard(prompt: PendingPermissionPrompt): void {
    const sessionId = prompt.sessionId ?? "";
    const card: PermissionCardData = {
      id: prompt.id,
      toolCallId: prompt.toolCallId,
      sessionId: prompt.sessionId,
      kind: prompt.kind,
      title: prompt.title,
      message: prompt.message,
      detail: prompt.detail,
      buttons: prompt.buttons,
      tooltips: prompt.tooltips,
      createdAt: Date.now(),
      category: prompt.category,
      suggestedPattern: prompt.suggestedPattern,
      patternRationale: prompt.patternRationale,
      sdkIntention: prompt.sdkIntention,
      sdkWarning: prompt.sdkWarning,
      sdkCommandIdentifiers: prompt.sdkCommandIdentifiers,
      browserUseDisclosure: prompt.browserUseDisclosure,
      primaryPattern: prompt.primaryPattern,
      canPersistAlwaysAllow: prompt.canPersistAlwaysAllow,
      sensitivePathWarning: prompt.sensitivePathWarning,
    };
    const arr = this.cards.get(sessionId) ?? [];
    arr.push(card);
    this.cards.set(sessionId, arr);
    this.pushToRenderer(sessionId);
    this.persistToDisk(sessionId);
  }

  /**
   * Patch a pending card with an async classification result.
   *
   * Called after the adapter's background classifier resolves. Adds the
   * classifier's category + suggestedPattern to the card so the renderer
   * can show a secondary "Allow broader pattern" button. Does NOT touch
   * primary button semantics — the primary pattern is locked on the
   * request itself when the card is created (safety invariant).
   *
   * No-op if the card is resolved, missing, or the classification adds
   * nothing new (no category, no pattern).
   *
   * Relay limitation: relay transports have no post-creation update channel,
   * so cards surfaced there only carry the t=0 primary. Follow-up.
   */
  updateClassification(requestId: string, classification: CommandClassification): void {
    const loc = this.findByRequestId(requestId);
    if (!loc) return;
    const card = this.cards.get(loc.sessionId)![loc.index];
    if (card.resolved) return;

    // Upgrade message from the generic SDK fallback to the classifier's
    // explanation when available. Only runs when the card is still showing
    // the fallback — never overwrites an SDK-supplied friendly description.
    const canUpgradeMessage =
      card.kind === "shell" &&
      card.message === `Marshal wants to run a terminal command` &&
      !!classification.explanation;

    const hasNewPattern =
      classification.category !== "unknown" || !!classification.suggestedPattern;

    if (!canUpgradeMessage && !hasNewPattern) return;

    if (canUpgradeMessage) {
      card.message = classification.explanation;
    }

    card.category = classification.category ?? card.category;
    card.suggestedPattern = classification.suggestedPattern ?? card.suggestedPattern;
    card.patternRationale = classification.patternRationale ?? card.patternRationale;

    this.pushToRenderer(loc.sessionId);
    this.persistToDisk(loc.sessionId);
  }

  /** User clicked Allow/Deny — update card state. */
  respondCard(requestId: string, action: PermissionAction): void {
    const loc = this.findByRequestId(requestId);
    if (!loc) return;
    const card = this.cards.get(loc.sessionId)![loc.index];
    card.resolved = action === "deny" ? "denied" : "allowed";
    this.pushToRenderer(loc.sessionId);
    this.persistToDisk(loc.sessionId);
  }

  /** resolve() returned {success: false} — mark card as denied (unless already terminal). */
  respondFailed(requestId: string): void {
    const loc = this.findByRequestId(requestId);
    if (!loc) return;
    const card = this.cards.get(loc.sessionId)![loc.index];
    if (card.resolved) return;
    card.resolved = "denied";
    this.pushToRenderer(loc.sessionId);
    this.persistToDisk(loc.sessionId);
  }

  /** Auto-deny timeout expired (see ApprovalBroker.DEFAULT_TIMEOUT_MS). Only affects unresolved cards. */
  timeoutCard(requestId: string): void {
    const loc = this.findByRequestId(requestId);
    if (!loc) return;
    const card = this.cards.get(loc.sessionId)![loc.index];
    if (card.resolved) return;
    card.resolved = "timed-out";
    this.pushToRenderer(loc.sessionId);
    this.persistToDisk(loc.sessionId);
  }

  /** SDK reports tool finished with output. */
  toolComplete(toolCallId: string, output: string, success: boolean): void {
    const loc = this.findByToolCallId(
      toolCallId,
      (c) => c.resolved === "allowed" && c.output == null,
    );
    if (!loc) return;
    const card = this.cards.get(loc.sessionId)![loc.index];
    card.output = output;
    card.resolved = success ? "allowed" : "failed";
    this.pushToRenderer(loc.sessionId);
    this.persistToDisk(loc.sessionId);
  }

  /**
   * Mark all "running" cards (allowed + no output) in a session as completed.
   *
   * Does NOT fire onPermissionResolved — these cards were already approved
   * (resolved="allowed") so the callback fired when the user clicked Allow.
   * Mini-mode hides the card at that point. resolveStuck only fills in the
   * missing output for cards whose tool finished without emitting completion events.
   */
  resolveStuck(sessionId: string): void {
    const cardSessionId = this.sessionManager.getPermissionPromptSessionId(sessionId);
    const arr = this.cards.get(cardSessionId);
    if (!arr) return;
    let changed = false;
    for (const card of arr) {
      if (card.resolved === "allowed" && card.output == null) {
        card.output = "";
        changed = true;
      }
    }
    if (!changed) return;
    this.pushToRenderer(cardSessionId);
    this.persistToDisk(cardSessionId);
  }

  /**
   * Load cards from disk for a session, merging with any already in memory.
   *
   * Known limitation: `ApprovalBroker`'s auto-deny timer lives only in
   * process memory. A card that was pending when the app exited will be
   * restored here still marked `resolved == undefined`, but the broker has
   * no entry for it and the SDK turn that was waiting on the response is
   * already gone (backend session torn down). Clicking Allow on such a
   * card flows through `respondCard` → `broker.resolve()` → returns false
   * → `respondFailed` marks the card "failed" — no tool executes. So the
   * UX is "click produces Failed after restart" rather than ghost-pending
   * forever. This is a stopgap while the 48h auto-deny is a stopgap itself;
   * when we decide what to do with auto-deny we should also decide whether
   * restored pending cards deserve their own UI state.
   */
  loadFromDisk(sessionId: string): void {
    const sessionData = this.sessionManager.getSession(sessionId);
    const diskCards = sessionData?.permissionCards ?? [];
    if (diskCards.length === 0) return;

    const existing = this.cards.get(sessionId) ?? [];
    const existingIds = new Set(existing.map((c) => c.id));
    const newFromDisk = diskCards
      .filter((c) => !existingIds.has(c.id))
      .map((card) => {
        if (card.resolved === "allowed" && card.output == null) {
          return { ...card, output: "" };
        }
        return card;
      });

    if (newFromDisk.length === 0) return;
    this.cards.set(sessionId, [...existing, ...newFromDisk]);
  }

  /** Clear all cards and drain pending broker promises for a session. */
  clearSession(sessionId: string): void {
    this.broker?.clearSession(sessionId);
    this.cards.delete(sessionId);
    this.pushToRenderer(sessionId);
  }

  // ── Internal: formatting + presentation ─────────────────────────────────

  /**
   * Handle a pending broker request: format the dialog, compute tooltips,
   * create the card, and notify external listeners.
   */
  private async handlePending(request: BrokerRequest): Promise<void> {
    const { permissionRequest: permReq } = request;
    const workspaceDir =
      this.sessionManager.getWorkspaceRootForSession(permReq.sessionId) ?? this.workspaceDir;
    const { title, message, detail } = await formatPermissionDialog(permReq, workspaceDir);

    // After async enrichment, the request may have been resolved/timed out
    if (!this.broker?.hasPending(request.requestId)) return;

    // Settings permission cards skip all shell/SDK enrichment.
    if (permReq.kind === "settings") {
      this.presentCard(request, title, message, detail);
      return;
    }

    // Browser code-execution tools (browser_run_code, browser_evaluate, etc.) set
    // origin:"synthesized-browser" and path:"*" because the target path is not known at
    // approval time. Show a human-readable card instead of the literal "*" path.
    if (
      permReq.kind === "write" &&
      permReq.origin === "synthesized-browser" &&
      permReq.path === "*"
    ) {
      const toolNameForDisplay = permReq.browserToolName ?? "browser code execution";
      const sdkPrompt = extractSdkPromptMetadata(permReq);
      // Browser code-execution writes must explicitly set category for spec compliance.
      request.classification = {
        category: "writes",
        explanation: "",
        suggestedPattern: null,
        patternRationale: null,
        source: "fallback",
        guardrailRuleId: null,
      };
      this.presentCard(
        request,
        "Browser code execution",
        `${toolNameForDisplay} may write files to disk`,
        detail,
        sdkPrompt,
      );
      return;
    }

    const isShell = permReq.kind === "shell";

    // Use pre-computed LLM classification explanation if provided by the caller
    const sdkPrompt = extractSdkPromptMetadata(permReq);
    let finalMessage = sdkPrompt.intention || message;
    let finalDetail = detail;
    if (
      request.classification?.explanation &&
      isShell &&
      message === `Marshal wants to run a terminal command`
    ) {
      finalMessage = request.classification.explanation;
      const raw = permReq.kind === "shell" ? permReq.command : "";
      finalDetail = truncateMiddle(`Command: ${raw}`);
    }

    if (sdkPrompt.warning) {
      // Appended last so withoutDuplicateSdkWarning's endsWith strip removes it on
      // the desktop card (where sdkWarning is also rendered as a prominent alert).
      // Mini-mode and the relay read warning only from this detail field.
      finalDetail = finalDetail
        ? `${finalDetail}\n\nWarning: ${sdkPrompt.warning}`
        : `Warning: ${sdkPrompt.warning}`;
    }

    this.presentCard(request, title, finalMessage, finalDetail, sdkPrompt);
  }

  /** Build the prompt, notify listeners, and add the card to the UI. */
  private presentCard(
    request: BrokerRequest,
    title: string,
    message: string,
    detail: string,
    sdkPrompt: SdkPromptMetadata = EMPTY_SDK_PROMPT_METADATA,
  ): void {
    const { permissionRequest: permReq } = request;
    const cardSessionId = this.sessionManager.getPermissionPromptSessionId(permReq.sessionId);
    const canPersist = this.canPersistAlwaysAllow(permReq);
    const buttons = cardButtonsFor(permReq, canPersist);
    // Relays get redacted text; mini-mode and the in-app card keep the full message.
    const external = externalPermissionPrompt(permReq, message, detail, buttons);

    const sensitiveHit = this.policy?.getSensitivePathHit(permReq);
    const sensitivePathWarning = sensitiveHit
      ? `${sensitiveHit.resolvedPath} is in a security-sensitive location`
      : undefined;

    const prompt: PendingPermissionPrompt = {
      id: request.requestId,
      toolCallId: permReq.toolCallId || "",
      sessionId: cardSessionId,
      kind: permReq.kind,
      title,
      message,
      detail,
      buttons,
      // Pass through undefined when no classification ran, so the renderer
      // can distinguish "classifier returned null (stored literal)" from
      // "classifier never ran (keep canonical label)".
      category: request.classification?.category,
      suggestedPattern: request.classification?.suggestedPattern,
      patternRationale: request.classification?.patternRationale,
      sdkIntention: sdkPrompt.intention,
      sdkWarning: sdkPrompt.warning,
      sdkCommandIdentifiers: sdkPrompt.commandIdentifiers,
      browserUseDisclosure: isBrowserUsePermission(permReq),
      // Heuristic primary locked by the adapter — drives the primary button's
      // label/tooltip. Never mutates after creation (safety invariant).
      primaryPattern: permReq.approvalPattern ?? null,
      canPersistAlwaysAllow: canPersist,
      isForgetCompletely: external.isForgetCompletely,
      sensitivePathWarning,
    };

    try {
      this.callbacks.onPrompt?.(
        title,
        external.message,
        external.detail,
        request.requestId,
        cardSessionId,
        undefined,
        external.buttons,
      );
    } catch (err) {
      log.error("[PermissionCardManager] onPrompt callback failed:", err);
    }

    // A relay can't approve forget completely, so its desktop card must exist.
    const relayHandled = this.callbacks.isRelayHandled?.(cardSessionId) ?? false;
    if (!relayHandled || external.isForgetCompletely) {
      try {
        // Pass full prompt — mini-mode reads from this callback and needs
        // enriched event details. OS notification redaction happens in main.ts.
        this.callbacks.onApprovalRequested?.(prompt);
      } catch (err) {
        log.error("[PermissionCardManager] onApprovalRequested callback failed:", err);
      }
      this.addCard(prompt);
      this.getWindow()?.flashFrame(true);
    }
  }

  // Mirrors PermissionPolicy.getGuardedShellPatterns' wildcard + guardrail
  // gates. Non-shell kinds use patternKey and are always representable.
  private canPersistAlwaysAllow(request: ApprovalRequest): boolean {
    // Settings cards (permission escalation, forget completely) are one-shot Allow/Deny.
    if (request.kind === "settings") return false;
    if (request.kind !== "shell") return true;
    // Sensitive-path shell writes always get "Always allow" — persistAllowRule stores
    // the resolved path to allowedSensitivePaths, not a shell pattern.
    if (this.policy?.getSensitivePathHit(request) ?? null) return true;
    const cmd = getCommandText(request);
    if (!cmd) return false;
    const heuristic = extractPattern(cmd);
    if (!heuristic || heuristic.trim() === "*") return false;
    const gated = applyGuardrails(
      cmd,
      {
        explanation: "",
        category: "unknown",
        suggestedPattern: heuristic,
        patternRationale: null,
        source: "fallback",
        guardrailRuleId: null,
      },
      { isReadOnlyCommand },
    );
    return !!gated.suggestedPattern;
  }

  private pushToRenderer(sessionId: string): void {
    this.onCardsChanged?.({ sessionId, cards: this.getCards(sessionId) });
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const cards = this.getCards(sessionId);
    win.webContents.send("permissions:cards-changed", { sessionId, cards });
  }

  private persistToDisk(sessionId: string): void {
    if (!sessionId) return;
    const cards = this.getCards(sessionId);
    this.sessionManager.savePermissionCards(sessionId, cards);
  }

  private findByRequestId(requestId: string): { sessionId: string; index: number } | null {
    for (const [sessionId, arr] of this.cards) {
      const index = arr.findIndex((c) => c.id === requestId);
      if (index !== -1) return { sessionId, index };
    }
    return null;
  }

  private findByToolCallId(
    toolCallId: string,
    filter: (c: PermissionCardData) => boolean,
  ): { sessionId: string; index: number } | null {
    for (const [sessionId, arr] of this.cards) {
      const index = arr.findIndex((c) => c.toolCallId === toolCallId && filter(c));
      if (index !== -1) return { sessionId, index };
    }
    return null;
  }
}
