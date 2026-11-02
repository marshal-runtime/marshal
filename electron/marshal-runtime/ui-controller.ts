import { validateUiApplicationManifest } from "@marshal/runtime/ui";

import type {
  RuntimeUiAction,
  RuntimeUiApplicationContent,
  RuntimeUiAuthorityDecision,
  RuntimeUiAuthorityRequest,
  RuntimeUiChatCardCommand,
  RuntimeUiChatMessageCommand,
  RuntimeUiCloseCommand,
  RuntimeUiCommandReceipt,
  RuntimeUiCommandResult,
  RuntimeUiContent,
  RuntimeUiEvent,
  RuntimeUiFocusCommand,
  RuntimeUiInstance,
  RuntimeUiListCommand,
  RuntimeUiNotificationCommand,
  RuntimeUiOpenCommand,
  RuntimeUiOwner,
  RuntimeUiOwnerIdentity,
  RuntimeUiPermission,
  RuntimeUiResult,
  RuntimeUiScope,
  RuntimeUiSnapshot,
  RuntimeUiUpdateCommand,
} from "../../common/runtime-ui";
import { normalizeDocumentExtras } from "./document-annotations";
import {
  assertOnlyKeys,
  awaitAbortable,
  deterministicId,
  failure,
  immutable,
  isoTime,
  normalizeError,
  normalizeSurface,
  ownerOf,
  sameOwner,
  sameScope,
  scopeKey,
  scopeOf,
  throwIfAborted,
  type RuntimeUiEventInput,
} from "./ui-controller-support";
import {
  applicationCallKind,
  RuntimeUiRateWindows,
  type RuntimeUiApplicationCallKind,
} from "./ui-rate-windows";
import { RuntimeUiViewLifecycle } from "./ui-view-lifecycle";
import { viewFieldsForSurface } from "./ui-view-options";

const DEFAULT_LIMITS: Required<RuntimeUiControllerLimits> = {
  maxPayloadBytes: 256 * 1024,
  maxPayloadDepth: 32,
  maxStringLength: 16_384,
  maxEventHistory: 256,
  maxCommandsPerWindow: 120,
  maxInstanceCallsPerWindow: 1_200,
  maxInstanceReadsPerWindow: 3_000,
  rateWindowMs: 60_000,
  maxIdempotencyEntries: 512,
  idempotencyTtlMs: 10 * 60_000,
};

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type RuntimeUiClock = () => number;
export type RuntimeUiAuthority = (
  request: RuntimeUiAuthorityRequest,
  signal?: AbortSignal,
) => Promise<RuntimeUiAuthorityDecision> | RuntimeUiAuthorityDecision;
export type RuntimeUiDocumentAccessIssuer = (filePath: string) => string;

export interface RuntimeUiNotificationDelivery {
  readonly deliveryId: string;
  readonly owner: RuntimeUiOwner;
  readonly title: string;
  readonly message: string;
}

export interface RuntimeUiChatMessageDelivery {
  readonly deliveryId: string;
  readonly owner: RuntimeUiOwner;
  readonly content: RuntimeUiChatMessageCommand["content"];
}

export interface RuntimeUiChatCardDelivery {
  readonly deliveryId: string;
  readonly owner: RuntimeUiOwner;
  readonly content: RuntimeUiContent;
}

export interface RuntimeUiDeliveryPorts {
  readonly notification: (
    delivery: RuntimeUiNotificationDelivery,
    signal?: AbortSignal,
  ) => Promise<void> | void;
  readonly chatMessage: (
    delivery: RuntimeUiChatMessageDelivery,
    signal?: AbortSignal,
  ) => Promise<void> | void;
  readonly chatCard: (
    delivery: RuntimeUiChatCardDelivery,
    signal?: AbortSignal,
  ) => Promise<void> | void;
}

export interface RuntimeUiControllerLimits {
  readonly maxPayloadBytes?: number;
  readonly maxPayloadDepth?: number;
  readonly maxStringLength?: number;
  readonly maxEventHistory?: number;
  /** Session-wide budget for `ui.*` commands (open/update/focus/close/list/cards). */
  readonly maxCommandsPerWindow?: number;
  /** Per-instance budget for an application's own non-read bridge calls. */
  readonly maxInstanceCallsPerWindow?: number;
  /** Per-instance budget for an application's own read bridge calls (polling). */
  readonly maxInstanceReadsPerWindow?: number;
  readonly rateWindowMs?: number;
  readonly maxIdempotencyEntries?: number;
  readonly idempotencyTtlMs?: number;
}

interface IdempotencyEntry {
  readonly digest: string;
  readonly promise: Promise<RuntimeUiCommandResult>;
  expiresAt: number;
}

export class MarshalRuntimeUiController {
  private readonly limits: Required<RuntimeUiControllerLimits>;
  private readonly instances = new Map<string, RuntimeUiInstance>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly rates: RuntimeUiRateWindows;
  private readonly subscribers = new Set<(event: RuntimeUiEvent) => void>();
  private readonly eventHistory: RuntimeUiEvent[] = [];
  private revision = 0;
  private disposed = false;
  private readonly views: RuntimeUiViewLifecycle;

  constructor(
    private readonly clock: RuntimeUiClock,
    private readonly authority: RuntimeUiAuthority,
    private readonly delivery: RuntimeUiDeliveryPorts,
    limits: RuntimeUiControllerLimits = {},
    private readonly issueDocumentAccess?: RuntimeUiDocumentAccessIssuer,
  ) {
    this.limits = normalizeLimits(limits);
    this.rates = new RuntimeUiRateWindows(clock, this.limits.rateWindowMs);
    this.views = new RuntimeUiViewLifecycle({
      instances: this.instances,
      clock,
      nextRevision: () => this.revision + 1,
      record: (event) => this.recordEvent(event),
      isDisposed: () => this.disposed,
      normalizeOwner: (owner) => this.normalizeOwner(owner),
      normalizeContent: (content) => this.normalizeContent(content),
    });
  }

  open(
    command: RuntimeUiOpenCommand,
    signal?: AbortSignal,
  ): Promise<RuntimeUiResult<RuntimeUiCommandResult>> {
    return this.run(async () => {
      const normalized = this.normalizeOpen(command);
      return this.executeIdempotent("open", normalized, signal, async () => {
        await this.authorize("ui.open", normalized, undefined, signal);
        this.consumeRate(normalized);
        if (normalized.replaceInstanceId) {
          const instance = this.views.replace(normalized);
          return immutable({
            receipt: this.receipt("open", normalized, instance.instanceId),
            instance,
          });
        }
        const instanceId = runtimeUiInstanceId(normalized);
        if (this.instances.has(instanceId)) {
          throw failure("idempotency-conflict", "Runtime UI instance identity already exists.");
        }
        const timestamp = isoTime(this.clock());
        const instance = immutable<RuntimeUiInstance>({
          instanceId,
          owner: ownerOf(normalized),
          surface: normalized.surface,
          content: normalized.content,
          idempotencyKey: normalized.idempotencyKey,
          revision: this.revision + 1,
          openedAt: timestamp,
          updatedAt: timestamp,
          focusedAt: timestamp,
          focusedBy: normalized.origin ?? "desktop",
          ...this.views.options(normalized, normalized.surface),
        });
        this.instances.set(instanceId, instance);
        this.views.sync(instance);
        this.recordEvent({
          type: "instance-opened",
          scope: scopeOf(normalized),
          instance,
        });
        return immutable({
          receipt: this.receipt("open", normalized, instanceId),
          instance,
        });
      });
    });
  }

  /** Host-internal read of a scope's open views (persistence, layout reports). */
  scopeInstances(scope: RuntimeUiScope): readonly RuntimeUiInstance[] {
    this.assertUsable();
    return this.scopedInstances(scope);
  }

  /** Re-opens views persisted with a session after a restart; see RuntimeUiViewLifecycle.restore. */
  restore(instances: readonly RuntimeUiInstance[]): number {
    this.assertUsable();
    return this.views.restore(instances);
  }

  /**
   * Resolves the instance targeted by an application's own bridge call
   * (capability invocation, resource read, host request). These calls are
   * budgeted per instance, reads separately from writes, so one polling view
   * cannot starve other views, its own user input, or the session-wide `ui.*`
   * command budget. `kind` defaults to the manifest risk of `capability`.
   */
  resolveApplicationCall(
    target: RuntimeUiOwner & {
      readonly instanceId: string;
      readonly capability?: string;
      readonly kind?: RuntimeUiApplicationCallKind;
    },
    signal?: AbortSignal,
  ): Promise<RuntimeUiResult<RuntimeUiInstance>> {
    return this.run(async () => {
      const owner = this.normalizeOwner(target);
      const instanceId = this.requiredString(target.instanceId, "Instance ID", 128);
      await this.authorize("ui.list", scopeOf(owner), undefined, signal);
      const instance = this.requireOwnedInstance(instanceId, owner);
      const kind = target.kind ?? applicationCallKind(instance, target.capability);
      const limit =
        kind === "read"
          ? this.limits.maxInstanceReadsPerWindow
          : this.limits.maxInstanceCallsPerWindow;
      this.rates.consume(
        `${scopeKey(owner)}:${instanceId}:${kind}`,
        limit,
        `This view sent more than ${limit} ${kind} requests in ${Math.ceil(
          this.limits.rateWindowMs / 1_000,
        )} seconds; wait a moment and try again.`,
      );
      return instance;
    });
  }

  update(
    command: RuntimeUiUpdateCommand,
    signal?: AbortSignal,
  ): Promise<RuntimeUiResult<RuntimeUiCommandResult>> {
    return this.run(async () => {
      const normalized = this.normalizeUpdate(command);
      return this.executeIdempotent("update", normalized, signal, async () => {
        await this.authorize("ui.update", normalized, normalized.instanceId, signal);
        this.consumeRate(normalized);
        const current = this.requireOwnedInstance(normalized.instanceId, normalized);
        const instance = immutable<RuntimeUiInstance>({
          ...current,
          content: normalized.content,
          revision: this.revision + 1,
          updatedAt: isoTime(this.clock()),
        });
        this.instances.set(instance.instanceId, instance);
        this.recordEvent({
          type: "instance-updated",
          scope: scopeOf(normalized),
          instance,
        });
        return immutable({
          receipt: this.receipt("update", normalized, instance.instanceId),
          instance,
        });
      });
    });
  }

  focus(
    command: RuntimeUiFocusCommand,
    signal?: AbortSignal,
  ): Promise<RuntimeUiResult<RuntimeUiCommandResult>> {
    return this.run(async () => {
      const normalized = this.normalizeTarget(command);
      return this.executeIdempotent("focus", normalized, signal, async () => {
        await this.authorize("ui.focus", normalized, normalized.instanceId, signal);
        this.consumeRate(normalized);
        const current = this.requireOwnedInstance(normalized.instanceId, normalized);
        const surface = normalized.surface ?? current.surface;
        const { title: _title, transient: _transient, anchor: _anchor, ...base } = current;
        const instance = immutable<RuntimeUiInstance>({
          ...base,
          ...viewFieldsForSurface(current, surface),
          surface,
          revision: this.revision + 1,
          ...(normalized.preserveFocus
            ? {}
            : {
                focusedAt: isoTime(this.clock()),
                focusedBy: ("origin" in normalized ? normalized.origin : undefined) ?? "desktop",
              }),
        });
        this.instances.set(instance.instanceId, instance);
        this.views.sync(instance);
        this.recordEvent({
          type: normalized.preserveFocus ? "instance-updated" : "instance-focused",
          scope: scopeOf(normalized),
          instance,
        });
        return immutable({
          receipt: this.receipt("focus", normalized, instance.instanceId),
          instance,
        });
      });
    });
  }

  close(
    command: RuntimeUiCloseCommand,
    signal?: AbortSignal,
  ): Promise<RuntimeUiResult<RuntimeUiCommandResult>> {
    return this.run(async () => {
      const normalized = this.normalizeTarget(command);
      return this.executeIdempotent("close", normalized, signal, async () => {
        await this.authorize("ui.close", normalized, normalized.instanceId, signal);
        this.consumeRate(normalized);
        const current = this.requireOwnedInstance(normalized.instanceId, normalized);
        this.instances.delete(current.instanceId);
        this.views.cancel(current.instanceId);
        this.recordEvent({
          type: "instance-closed",
          scope: scopeOf(normalized),
          instanceId: current.instanceId,
          owner: current.owner,
          reason: "command",
        });
        return immutable({
          receipt: this.receipt("close", normalized, current.instanceId),
        });
      });
    });
  }

  list(
    command: RuntimeUiListCommand,
    signal?: AbortSignal,
  ): Promise<RuntimeUiResult<RuntimeUiCommandResult>> {
    return this.run(async () => {
      const normalized = this.normalizeList(command);
      await this.authorize("ui.list", normalized, undefined, signal);
      this.consumeRate(normalized);
      const instances = this.scopedInstances(normalized).filter(
        (instance) =>
          (!normalized.owner ||
            (instance.owner.extensionId === normalized.owner.extensionId &&
              instance.owner.applicationId === normalized.owner.applicationId)) &&
          (!normalized.surface || instance.surface === normalized.surface),
      );
      return immutable({
        receipt: this.receipt("list", normalized),
        instances,
      });
    });
  }

  snapshot(
    scope: RuntimeUiScope,
    signal?: AbortSignal,
  ): Promise<RuntimeUiResult<RuntimeUiSnapshot>> {
    return this.run(async () => {
      const normalized = this.normalizeScope(scope);
      await this.authorize("ui.snapshot", normalized, undefined, signal);
      this.consumeRate(normalized);
      return immutable({
        revision: this.revision,
        generatedAt: isoTime(this.clock()),
        scope: normalized,
        instances: this.scopedInstances(normalized),
        events: this.eventHistory.filter((event) => sameScope(event.scope, normalized)),
      });
    });
  }

  showNotification(
    command: RuntimeUiNotificationCommand,
    signal?: AbortSignal,
  ): Promise<RuntimeUiResult<RuntimeUiCommandResult>> {
    return this.run(async () => {
      const normalized = this.normalizeNotification(command);
      return this.executeDelivery(
        "notification.show",
        "ui.notification.show",
        "notification",
        normalized,
        signal,
        (deliveryId) =>
          this.delivery.notification(
            immutable({
              deliveryId,
              owner: ownerOf(normalized),
              title: normalized.title,
              message: normalized.message,
            }),
            signal,
          ),
      );
    });
  }

  postChatMessage(
    command: RuntimeUiChatMessageCommand,
    signal?: AbortSignal,
  ): Promise<RuntimeUiResult<RuntimeUiCommandResult>> {
    return this.run(async () => {
      const normalized = this.normalizeChatMessage(command);
      this.requireChatScope(normalized);
      return this.executeDelivery(
        "chat.message.post",
        "ui.chat.message.post",
        "chat-message",
        normalized,
        signal,
        (deliveryId) =>
          this.delivery.chatMessage(
            immutable({
              deliveryId,
              owner: ownerOf(normalized),
              content: normalized.content,
            }),
            signal,
          ),
      );
    });
  }

  showChatCard(
    command: RuntimeUiChatCardCommand,
    signal?: AbortSignal,
  ): Promise<RuntimeUiResult<RuntimeUiCommandResult>> {
    return this.run(async () => {
      const normalized = this.normalizeChatCard(command);
      this.requireChatScope(normalized);
      return this.executeIdempotent("chat.card.show", normalized, signal, async () => {
        await this.authorize("ui.chat.card.show", normalized, undefined, signal);
        this.consumeRate(normalized);
        const deliveryId = deterministicId("runtime-ui-delivery", {
          action: "chat.card.show",
          owner: ownerOf(normalized),
          idempotencyKey: normalized.idempotencyKey,
        });
        const instanceId = runtimeUiInstanceId({
          ...normalized,
          surface: "inline-card",
          idempotencyKey: `chat-card:${normalized.idempotencyKey}`,
        });
        if (this.instances.has(instanceId)) {
          throw failure("idempotency-conflict", "Runtime UI chat card identity already exists.");
        }
        await this.delivery.chatCard(
          immutable({
            deliveryId,
            owner: ownerOf(normalized),
            content: normalized.content,
          }),
          signal,
        );
        throwIfAborted(signal);
        this.assertUsable();
        const timestamp = isoTime(this.clock());
        const instance = immutable<RuntimeUiInstance>({
          instanceId,
          owner: ownerOf(normalized),
          surface: "inline-card",
          content: normalized.content,
          idempotencyKey: normalized.idempotencyKey,
          revision: this.revision + 1,
          openedAt: timestamp,
          updatedAt: timestamp,
          focusedAt: timestamp,
          ...this.views.options(normalized, "inline-card"),
        });
        this.instances.set(instanceId, instance);
        this.views.sync(instance);
        this.recordEvent({
          type: "instance-opened",
          scope: scopeOf(normalized),
          instance,
        });
        this.recordEvent({
          type: "delivery-succeeded",
          scope: scopeOf(normalized),
          owner: ownerOf(normalized),
          delivery: "chat-card",
          deliveryId,
        });
        return immutable({
          receipt: this.receipt("chat.card.show", normalized, instanceId, deliveryId),
          instance,
        });
      });
    });
  }

  /**
   * CF-05 host stream push: emits a TRANSIENT owner-scoped delivery-stream
   * event to live subscribers. Deliberately bypasses `recordEvent`'s history:
   * chunks are progressive push data — replaying them from `snapshot()` would
   * re-deliver stale fragments; the delivery read capability remains the
   * authoritative pull surface.
   */
  publishDeliveryStream(
    owner: RuntimeUiOwner,
    stream: {
      readonly requestId: string;
      readonly streamSequence: number;
      readonly chunk: import("../../common/runtime-ui").RuntimeUiDeliveryStreamChunk;
      readonly terminal: boolean;
      readonly terminalState?: string;
    },
  ): void {
    this.revision++;
    const enriched: RuntimeUiEvent = immutable({
      type: "delivery-stream" as const,
      scope: scopeOf(owner),
      owner: immutable({ ...owner }),
      requestId: stream.requestId,
      streamSequence: stream.streamSequence,
      chunk: stream.chunk,
      terminal: stream.terminal,
      ...(stream.terminalState !== undefined ? { terminalState: stream.terminalState } : {}),
      sequence: this.revision,
      occurredAt: isoTime(this.clock()),
    });
    for (const subscriber of this.subscribers) subscriber(enriched);
  }

  subscribe(subscriber: (event: RuntimeUiEvent) => void): () => void {
    this.assertUsable();
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  refreshApplication(
    owner: RuntimeUiOwnerIdentity,
    content: Omit<RuntimeUiApplicationContent, "state">,
  ): RuntimeUiResult<readonly string[]> {
    try {
      this.assertUsable();
      const normalizedOwner = this.normalizeOwnerIdentity(owner);
      const replacements = [...this.instances.values()]
        .filter(
          (instance) =>
            instance.owner.extensionId === normalizedOwner.extensionId &&
            instance.owner.applicationId === normalizedOwner.applicationId &&
            instance.content.kind === "application",
        )
        .map((instance) => ({
          instance,
          content: this.normalizeContent({
            ...content,
            ...(instance.content.kind === "application" && instance.content.state
              ? { state: instance.content.state }
              : {}),
          }),
        }));
      for (const replacement of replacements) {
        const instance = immutable<RuntimeUiInstance>({
          ...replacement.instance,
          content: replacement.content,
          revision: this.revision + 1,
          updatedAt: isoTime(this.clock()),
        });
        this.instances.set(instance.instanceId, instance);
        this.recordEvent({ type: "instance-updated", scope: scopeOf(instance.owner), instance });
      }
      return {
        ok: true,
        value: immutable(replacements.map(({ instance }) => instance.instanceId)),
      };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  }

  invalidateOwner(owner: RuntimeUiOwnerIdentity): RuntimeUiResult<readonly string[]> {
    try {
      this.assertUsable();
      const normalized = this.normalizeOwnerIdentity(owner);
      const matching = [...this.instances.values()].filter(
        (instance) =>
          instance.owner.extensionId === normalized.extensionId &&
          instance.owner.applicationId === normalized.applicationId,
      );
      const byScope = new Map<string, RuntimeUiInstance[]>();
      for (const instance of matching) {
        this.instances.delete(instance.instanceId);
        this.views.cancel(instance.instanceId);
        const key = scopeKey(instance.owner);
        const scoped = byScope.get(key) ?? [];
        scoped.push(instance);
        byScope.set(key, scoped);
        this.recordEvent({
          type: "instance-closed",
          scope: scopeOf(instance.owner),
          instanceId: instance.instanceId,
          owner: instance.owner,
          reason: "owner-invalidated",
        });
      }
      for (const instances of byScope.values()) {
        const scope = scopeOf(instances[0].owner);
        this.recordEvent({
          type: "owner-invalidated",
          scope,
          owner: normalized,
          closedInstanceIds: instances.map((instance) => instance.instanceId).sort(),
        });
      }
      return { ok: true, value: immutable(matching.map((instance) => instance.instanceId).sort()) };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.views.dispose();
    this.instances.clear();
    this.idempotency.clear();
    this.rates.clear();
    this.eventHistory.length = 0;
    this.subscribers.clear();
  }

  private executeDelivery(
    action: Extract<RuntimeUiAction, "notification.show" | "chat.message.post" | "chat.card.show">,
    permission: Extract<
      RuntimeUiPermission,
      "ui.notification.show" | "ui.chat.message.post" | "ui.chat.card.show"
    >,
    delivery: Extract<RuntimeUiEvent, { type: "delivery-succeeded" }>["delivery"],
    command: RuntimeUiNotificationCommand | RuntimeUiChatMessageCommand | RuntimeUiChatCardCommand,
    signal: AbortSignal | undefined,
    send: (deliveryId: string) => Promise<void> | void,
  ): Promise<RuntimeUiCommandResult> {
    return this.executeIdempotent(action, command, signal, async () => {
      await this.authorize(permission, command, undefined, signal);
      this.consumeRate(command);
      throwIfAborted(signal);
      const deliveryId = deterministicId("runtime-ui-delivery", {
        action,
        owner: ownerOf(command),
        idempotencyKey: command.idempotencyKey,
      });
      await send(deliveryId);
      throwIfAborted(signal);
      this.assertUsable();
      this.recordEvent({
        type: "delivery-succeeded",
        scope: scopeOf(command),
        owner: ownerOf(command),
        delivery,
        deliveryId,
      });
      return immutable({
        receipt: this.receipt(action, command, undefined, deliveryId),
      });
    });
  }

  private async executeIdempotent(
    action: Exclude<RuntimeUiAction, "list">,
    command:
      | RuntimeUiOpenCommand
      | RuntimeUiUpdateCommand
      | RuntimeUiFocusCommand
      | RuntimeUiCloseCommand
      | RuntimeUiNotificationCommand
      | RuntimeUiChatMessageCommand
      | RuntimeUiChatCardCommand,
    signal: AbortSignal | undefined,
    operation: () => Promise<RuntimeUiCommandResult>,
  ): Promise<RuntimeUiCommandResult> {
    this.assertUsable();
    throwIfAborted(signal);
    this.pruneIdempotency();
    const entryKey = deterministicId("runtime-ui-idempotency", {
      action,
      owner: ownerOf(command),
      idempotencyKey: command.idempotencyKey,
    });
    const digest = deterministicId("runtime-ui-command", command);
    const existing = this.idempotency.get(entryKey);
    if (existing) {
      if (existing.digest !== digest) {
        throw failure(
          "idempotency-conflict",
          "The Runtime UI idempotency key was reused with different input.",
        );
      }
      const result = await awaitAbortable(existing.promise, signal);
      return immutable({
        ...result,
        receipt: { ...result.receipt, status: "deduplicated" },
      });
    }
    if (this.idempotency.size >= this.limits.maxIdempotencyEntries) {
      throw failure("idempotency-capacity", "Runtime UI idempotency capacity was reached.");
    }
    const promise = Promise.resolve().then(operation);
    const entry: IdempotencyEntry = {
      digest,
      promise,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    this.idempotency.set(entryKey, entry);
    void promise.then(
      () => {
        entry.expiresAt = this.clock() + this.limits.idempotencyTtlMs;
      },
      () => {
        if (this.idempotency.get(entryKey) === entry) this.idempotency.delete(entryKey);
      },
    );
    return awaitAbortable(promise, signal);
  }

  private async authorize(
    permission: RuntimeUiPermission,
    command: RuntimeUiScope & Partial<RuntimeUiOwnerIdentity>,
    instanceId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    this.assertUsable();
    throwIfAborted(signal);
    const scope = scopeOf(command);
    const owner =
      command.extensionId && command.applicationId
        ? {
            extensionId: command.extensionId,
            applicationId: command.applicationId,
          }
        : undefined;
    const decision = await this.authority(
      immutable({
        permission,
        scope,
        ...(owner ? { owner } : {}),
        ...(instanceId ? { instanceId } : {}),
      }),
      signal,
    );
    throwIfAborted(signal);
    this.assertUsable();
    if (!decision.allowed) {
      throw failure(
        "permission-denied",
        decision.reason?.slice(0, this.limits.maxStringLength) ??
          "Runtime UI permission was denied.",
      );
    }
    if (!sameScope(decision.scope, scope)) {
      throw failure(
        "permission-denied",
        "Runtime UI authority returned a different session or workspace scope.",
      );
    }
  }

  private consumeRate(scope: RuntimeUiScope): void {
    this.rates.consume(
      scopeKey(scope),
      this.limits.maxCommandsPerWindow,
      "Runtime UI command rate limit was exceeded.",
    );
  }

  private requireOwnedInstance(instanceId: string, owner: RuntimeUiOwner): RuntimeUiInstance {
    const instance = this.instances.get(instanceId);
    if (!instance || !sameOwner(instance.owner, owner)) {
      throw failure("not-found", "Runtime UI instance was not found for this owner and scope.");
    }
    return instance;
  }

  private scopedInstances(scope: RuntimeUiScope): RuntimeUiInstance[] {
    return [...this.instances.values()]
      .filter((instance) => sameScope(instance.owner, scope))
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  }

  private recordEvent(event: RuntimeUiEventInput): void {
    this.revision++;
    const enriched: RuntimeUiEvent = immutable({
      ...event,
      sequence: this.revision,
      occurredAt: isoTime(this.clock()),
    });
    this.eventHistory.push(enriched);
    if (this.eventHistory.length > this.limits.maxEventHistory) {
      this.eventHistory.splice(0, this.eventHistory.length - this.limits.maxEventHistory);
    }
    for (const subscriber of this.subscribers) subscriber(enriched);
  }

  private receipt(
    action: RuntimeUiAction,
    command: RuntimeUiScope & { readonly idempotencyKey?: string },
    instanceId?: string,
    deliveryId?: string,
  ): RuntimeUiCommandReceipt {
    return immutable({
      receiptId: deterministicId("runtime-ui-receipt", {
        action,
        scope: scopeOf(command),
        idempotencyKey: command.idempotencyKey,
        instanceId,
        deliveryId,
      }),
      action,
      status: "applied",
      completedAt: isoTime(this.clock()),
      revision: this.revision,
      ...(instanceId ? { instanceId } : {}),
      ...(deliveryId ? { deliveryId } : {}),
    });
  }

  private normalizeOpen(command: RuntimeUiOpenCommand): RuntimeUiOpenCommand {
    const surface = normalizeSurface(command.surface);
    const normalized = {
      ...this.normalizeOwner(command),
      surface,
      content: this.normalizeContent(command.content),
      idempotencyKey: this.requiredString(command.idempotencyKey, "Idempotency key", 256),
      ...(command.origin === "remote" || command.origin === "desktop"
        ? { origin: command.origin }
        : {}),
      ...this.views.rawOptions(command, surface),
      ...(command.replaceInstanceId === undefined
        ? {}
        : {
            replaceInstanceId: this.requiredString(
              command.replaceInstanceId,
              "Replaced instance ID",
              128,
            ),
          }),
    };
    this.validatePayload(normalized);
    return immutable(normalized);
  }

  private normalizeUpdate(command: RuntimeUiUpdateCommand): RuntimeUiUpdateCommand {
    const normalized = {
      ...this.normalizeOwner(command),
      instanceId: this.requiredString(command.instanceId, "Instance ID", 128),
      content: this.normalizeContent(command.content),
      idempotencyKey: this.requiredString(command.idempotencyKey, "Idempotency key", 256),
    };
    this.validatePayload(normalized);
    return immutable(normalized);
  }

  private normalizeTarget(
    command: RuntimeUiFocusCommand | RuntimeUiCloseCommand,
  ): RuntimeUiFocusCommand {
    const origin = "origin" in command ? command.origin : undefined;
    const surface = "surface" in command ? command.surface : undefined;
    const preserveFocus = "preserveFocus" in command && command.preserveFocus === true;
    return immutable({
      ...this.normalizeOwner(command),
      instanceId: this.requiredString(command.instanceId, "Instance ID", 128),
      idempotencyKey: this.requiredString(command.idempotencyKey, "Idempotency key", 256),
      ...(origin === "remote" || origin === "desktop" ? { origin } : {}),
      ...(surface === undefined ? {} : { surface: normalizeSurface(surface) }),
      ...(preserveFocus ? { preserveFocus } : {}),
    });
  }

  private normalizeList(command: RuntimeUiListCommand): RuntimeUiListCommand {
    return immutable({
      ...this.normalizeScope(command),
      ...(command.owner ? { owner: this.normalizeOwnerIdentity(command.owner) } : {}),
      ...(command.surface ? { surface: normalizeSurface(command.surface) } : {}),
    });
  }

  private normalizeNotification(
    command: RuntimeUiNotificationCommand,
  ): RuntimeUiNotificationCommand {
    const normalized = {
      ...this.normalizeOwner(command),
      title: this.requiredString(command.title, "Notification title", 512),
      message: this.requiredString(
        command.message,
        "Notification message",
        this.limits.maxStringLength,
      ),
      idempotencyKey: this.requiredString(command.idempotencyKey, "Idempotency key", 256),
    };
    this.validatePayload(normalized);
    return immutable(normalized);
  }

  private normalizeChatMessage(command: RuntimeUiChatMessageCommand): RuntimeUiChatMessageCommand {
    const content = this.normalizeContent(command.content);
    if (content.kind !== "text" && content.kind !== "markdown") {
      throw failure("invalid-request", "Chat messages support only text or markdown.");
    }
    const normalized = {
      ...this.normalizeOwner(command),
      content,
      idempotencyKey: this.requiredString(command.idempotencyKey, "Idempotency key", 256),
    };
    this.validatePayload(normalized);
    return immutable(normalized);
  }

  private normalizeChatCard(command: RuntimeUiChatCardCommand): RuntimeUiChatCardCommand {
    const normalized = {
      ...this.normalizeOwner(command),
      content: this.normalizeContent(command.content),
      idempotencyKey: this.requiredString(command.idempotencyKey, "Idempotency key", 256),
      ...this.views.rawOptions(command, "inline-card"),
    };
    this.validatePayload(normalized);
    return immutable(normalized);
  }

  private normalizeContent(content: RuntimeUiContent): RuntimeUiContent {
    assertPlainJson(content, 0, this.limits);
    if (typeof content !== "object" || content === null || Array.isArray(content)) {
      throw failure("invalid-request", "Runtime UI content must be a plain object.");
    }
    let normalized: RuntimeUiContent;
    if (content.kind === "text") {
      assertOnlyKeys(content, ["kind", "text"]);
      normalized = {
        kind: "text",
        text: this.requiredString(content.text, "Runtime UI text", this.limits.maxStringLength),
      };
    } else if (content.kind === "markdown") {
      assertOnlyKeys(content, ["kind", "markdown"]);
      normalized = {
        kind: "markdown",
        markdown: this.requiredString(
          content.markdown,
          "Runtime UI markdown",
          this.limits.maxStringLength,
        ),
      };
    } else if (content.kind === "file") {
      assertOnlyKeys(content, ["kind", "path", "readCapability", "revealLine", "annotations"]);
      const documentPath = this.requiredString(content.path, "Document path", 4096);
      const readCapability = this.issueDocumentAccess?.(documentPath);
      normalized = {
        kind: "file",
        path: documentPath,
        ...normalizeDocumentExtras(content, (message) => failure("invalid-request", message)),
        ...(readCapability
          ? {
              readCapability: this.requiredString(
                readCapability,
                "Document access token",
                this.limits.maxStringLength,
              ),
            }
          : {}),
      };
    } else if (content.kind === "application") {
      assertOnlyKeys(content, ["kind", "renderId", "resource", "descriptor", "state"]);
      if (
        typeof content.descriptor !== "object" ||
        content.descriptor === null ||
        Array.isArray(content.descriptor)
      ) {
        throw failure("invalid-request", "Runtime UI application descriptor is required.");
      }
      if (
        content.state !== undefined &&
        (typeof content.state !== "object" ||
          content.state === null ||
          Array.isArray(content.state))
      ) {
        throw failure("invalid-request", "Runtime UI application state must be a plain object.");
      }
      if (
        typeof content.resource !== "object" ||
        content.resource === null ||
        Array.isArray(content.resource)
      ) {
        throw failure("invalid-request", "Runtime UI application resource is required.");
      }
      assertOnlyKeys(content.resource, ["uri", "mimeType", "name"]);
      let descriptor: RuntimeUiApplicationContent["descriptor"];
      try {
        descriptor = validateUiApplicationManifest(content.descriptor);
      } catch {
        throw failure("invalid-request", "Runtime UI application descriptor is invalid.");
      }
      normalized = {
        kind: "application",
        renderId: this.requiredString(content.renderId, "Runtime UI render ID", 256),
        resource: {
          uri: this.requiredString(
            content.resource.uri,
            "Runtime UI application resource URI",
            2_048,
          ),
          mimeType: this.requiredString(
            content.resource.mimeType,
            "Runtime UI application resource MIME type",
            256,
          ),
          ...(content.resource.name
            ? {
                name: this.requiredString(
                  content.resource.name,
                  "Runtime UI application resource name",
                  512,
                ),
              }
            : {}),
        },
        descriptor,
        ...(content.state ? { state: content.state } : {}),
      };
    } else {
      throw failure("invalid-request", "Runtime UI content kind is invalid.");
    }
    this.validatePayload(normalized);
    return immutable(normalized);
  }

  private normalizeOwner(owner: RuntimeUiOwner): RuntimeUiOwner {
    return immutable({
      ...this.normalizeScope(owner),
      ...this.normalizeOwnerIdentity(owner),
    });
  }

  private normalizeOwnerIdentity(owner: RuntimeUiOwnerIdentity): RuntimeUiOwnerIdentity {
    return immutable({
      extensionId: this.requiredString(owner.extensionId, "Extension ID", 256),
      applicationId: this.requiredString(owner.applicationId, "Application ID", 256),
    });
  }

  private normalizeScope(scope: RuntimeUiScope): RuntimeUiScope {
    const workspaceName = this.requiredString(scope.workspaceName, "Workspace name", 256);
    if (scope.applicationScope !== undefined) {
      if (
        (scope.applicationScope !== "user" && scope.applicationScope !== "workspace") ||
        scope.sessionId !== undefined
      ) {
        throw failure(
          "invalid-request",
          "Persistent application scope cannot contain a session ID.",
        );
      }
      return immutable({ applicationScope: scope.applicationScope, workspaceName });
    }
    return immutable({
      sessionId: this.requiredString(scope.sessionId, "Session ID", 256),
      workspaceName,
    });
  }

  private requireChatScope(scope: RuntimeUiScope): void {
    if (scope.applicationScope || !scope.sessionId) {
      throw failure("invalid-request", "Chat delivery requires an explicit session owner.");
    }
  }

  private requiredString(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw failure("invalid-request", `${label} is required.`);
    }
    if (value.length > Math.min(maxLength, this.limits.maxStringLength)) {
      throw failure("invalid-request", `${label} exceeds the maximum supported string length.`);
    }
    return value;
  }

  private validatePayload(value: unknown): void {
    assertPlainJson(value, 0, this.limits);
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, "utf8") > this.limits.maxPayloadBytes) {
      throw failure("invalid-request", "Runtime UI payload exceeds the maximum byte size.");
    }
  }

  private pruneIdempotency(): void {
    const now = this.clock();
    for (const [key, entry] of this.idempotency) {
      if (entry.expiresAt <= now) this.idempotency.delete(key);
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw failure("runtime-unavailable", "Runtime UI controller is disposed.");
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<RuntimeUiResult<T>> {
    try {
      this.assertUsable();
      return { ok: true, value: await operation() };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  }
}

export function runtimeUiInstanceId(command: RuntimeUiOpenCommand): string {
  const owner = ownerOf(command);
  return `rui_${deterministicId("runtime-ui-instance-v1", {
    ...scopeOf(owner),
    extensionId: owner.extensionId,
    applicationId: owner.applicationId,
    idempotencyKey: command.idempotencyKey,
  })}`;
}

function normalizeLimits(limits: RuntimeUiControllerLimits): Required<RuntimeUiControllerLimits> {
  const normalized = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Runtime UI limit "${name}" must be a positive safe integer.`);
    }
  }
  return Object.freeze(normalized);
}

function assertPlainJson(
  value: unknown,
  depth: number,
  limits: Required<RuntimeUiControllerLimits>,
): void {
  if (depth > limits.maxPayloadDepth) {
    throw failure("invalid-request", "Runtime UI payload exceeds the maximum depth.");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === "string") {
    if (value.length > limits.maxStringLength) {
      throw failure("invalid-request", "Runtime UI payload contains an oversized string.");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) assertPlainJson(child, depth + 1, limits);
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw failure("invalid-request", "Runtime UI payload must contain only plain JSON objects.");
  }
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw failure("invalid-request", `Runtime UI payload key "${key}" is not allowed.`);
    }
    if (key.length > limits.maxStringLength) {
      throw failure("invalid-request", "Runtime UI payload contains an oversized key.");
    }
    assertPlainJson(child, depth + 1, limits);
  }
}
