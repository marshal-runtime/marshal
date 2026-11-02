import { createHash, randomUUID } from "node:crypto";

import type { AgentMessageState, TurnEvent } from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import type {
  AgentMessageDeliveryContext,
  AgentMessageDeliveryResult,
  AgentMessageOutbox,
  AgentMessageRecord,
} from "../agent-message-outbox";
import type { SessionManager } from "../sessions";
import { wrapUntrusted } from "../untrusted-wrap";

export interface SelectedSessionOwner {
  extensionId: string;
  applicationId: string;
  workspaceName: string;
  applicationScope?: "user" | "workspace";
  sessionId?: string;
}

export interface SelectedSessionTarget {
  sessionId: string;
  workspaceName: string;
  runtimeId: string;
}

export interface SelectedSessionGrant {
  grantId: string;
  targetSessionId: string;
  expiresAt: string;
}

export interface SelectedSessionSendRequest {
  grantId: string;
  requestId: string;
  message: string;
  context?: string;
  attachmentHandles?: string[];
}

export interface SelectedSessionProgress {
  sequence: number;
  type: "text" | "status" | "retry" | "error";
  text?: string;
}

/**
 * CF-05 host stream push: one bounded progressive-answer fragment, emitted to
 * `SelectedSessionDeliveryOptions.onStreamChunk` as it happens so the host can
 * forward it to the OWNING extension application UI. `streamSequence` is
 * strictly increasing per request; exactly one terminal chunk (carrying the
 * final delivery state) concludes each delivery attempt's stream. Push-only —
 * `read()` stays the authoritative pull surface.
 */
export interface SelectedSessionStreamChunk {
  requestId: string;
  streamSequence: number;
  kind: "text" | "status" | "retry" | "error";
  text?: string;
  terminal: boolean;
  terminalState?: string;
}

export interface SelectedSessionReceipt {
  requestId: string;
  messageId: string;
  targetSessionId: string;
  /** Marshal's durable user-message ID identifies this logical turn across providers. */
  turnId?: string;
  state: AgentMessageState;
  response: string;
  responseTruncated: boolean;
  cursor: string;
  reset: boolean;
  events: SelectedSessionProgress[];
  error?: string;
}

export interface SelectedSessionDeliveryOptions {
  outbox: AgentMessageOutbox;
  sessions: Pick<SessionManager, "sendAndCollect" | "isSessionBusy"> &
    Partial<Pick<SessionManager, "cancelOwnedTurn">>;
  getTarget(sessionId: string): Promise<SelectedSessionTarget | null>;
  currentRuntimeId(): string;
  isOwnerActive(owner: SelectedSessionOwner): boolean | Promise<boolean>;
  isJobActive?(
    jobId: string,
    owner: SelectedSessionOwner,
    target: SelectedSessionTarget,
  ): boolean | Promise<boolean>;
  resolveAttachments?(request: {
    owner: SelectedSessionOwner;
    target: SelectedSessionTarget;
    handles: readonly string[];
  }): Promise<{
    attachments: Array<{ type: "file"; path: string; displayName?: string; byteLength: number }>;
    dispose?: () => void | Promise<void>;
  }>;
  now?: () => number;
  /**
   * CF-05: live stream push to the owning application UI. Fired synchronously
   * from the delivery path; a listener failure is swallowed (never breaks the
   * delivery itself).
   */
  onStreamChunk?(owner: SelectedSessionOwner, chunk: SelectedSessionStreamChunk): void;
}

interface DeliveryEnvelope {
  version: 1;
  owner: SelectedSessionOwner;
  target: SelectedSessionTarget;
  requestId: string;
  message: string;
  context?: string;
  attachmentHandles?: string[];
  jobId?: string;
}

interface ProgressBuffer {
  epoch: string;
  sequence: number;
  text: string;
  truncated: boolean;
  events: SelectedSessionProgress[];
}

const MAX_TEXT = 32_768;
const MAX_RESPONSE = 65_536;
/** Hard per-chunk bound for the CF-05 stream push (delivery buffers keep their own larger bounds). */
const STREAM_CHUNK_MAX_TEXT = 8_192;
const MAX_HANDLES = 8;
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS = 128;
const MAX_BUFFERS = 256;
const GRANT_TTL_MS = 8 * 60 * 60 * 1000;
const log = createLogger("SelectedSessionDelivery");
const TERMINAL = new Set<AgentMessageState>([
  "processed",
  "dead-letter",
  "delivery-unknown",
  "cancelled",
]);

export class SelectedSessionDeliveryService {
  private readonly grants = new Map<
    string,
    {
      ownerKey: string;
      owner: SelectedSessionOwner;
      target: SelectedSessionTarget;
      expiresAt: number;
    }
  >();
  private readonly progress = new Map<string, ProgressBuffer>();
  private readonly ownerEpochs = new Map<string, number>();
  private readonly observers = new Map<string, Set<() => void>>();
  private readonly now: () => number;

  constructor(private readonly options: SelectedSessionDeliveryOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Only the native host picker may call this; it is deliberately not a capability. */
  async grant(
    ownerValue: SelectedSessionOwner,
    targetSessionId: string,
  ): Promise<SelectedSessionGrant> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    await this.assertOwnerActive(owner);
    const target = await this.targetForOwner(owner, targetSessionId);
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= this.now()) this.grants.delete(id);
    }
    if (this.grants.size >= 1000)
      throw failure("resource_exhausted", "Too many session selection grants.");
    const grantId = randomUUID();
    const expiresAt = this.now() + GRANT_TTL_MS;
    this.grants.set(grantId, { ownerKey: ownerKey(owner), owner, target, expiresAt });
    return {
      grantId,
      targetSessionId: target.sessionId,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async revokeOwner(ownerValue: SelectedSessionOwner): Promise<void> {
    const key = ownerKey(normalizeSelectedSessionOwner(ownerValue));
    this.ownerEpochs.set(key, (this.ownerEpochs.get(key) ?? 0) + 1);
    for (const [id, grant] of this.grants) {
      if (grant.ownerKey === key) this.grants.delete(id);
    }
    await Promise.all(
      this.options.outbox
        .list()
        .filter((message) => message.kind === "selected-session" && message.source === key)
        .map((message) =>
          this.options.outbox.cancelBeforeBackendAcceptance(message.messageId, key, message.target),
        ),
    );
  }

  async revokeApplication(identity: { extensionId: string; applicationId: string }): Promise<void> {
    const owners = new Map<string, SelectedSessionOwner>();
    for (const grant of this.grants.values()) {
      if (
        grant.owner.extensionId === identity.extensionId &&
        grant.owner.applicationId === identity.applicationId
      )
        owners.set(grant.ownerKey, grant.owner);
    }
    for (const message of this.options.outbox.list()) {
      if (message.kind !== "selected-session") continue;
      try {
        const { owner } = parseEnvelope(message);
        if (
          owner.extensionId === identity.extensionId &&
          owner.applicationId === identity.applicationId
        )
          owners.set(ownerKey(owner), owner);
      } catch {
        /* Invalid persisted requests are rejected by the dispatcher. */
      }
    }
    await Promise.all([...owners.values()].map((owner) => this.revokeOwner(owner)));
  }

  async resolveGrant(
    ownerValue: SelectedSessionOwner,
    grantId: string,
  ): Promise<SelectedSessionTarget> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    boundedText(grantId, "grantId", 256);
    await this.assertOwnerActive(owner);
    const grant = this.grants.get(grantId);
    if (!grant || grant.ownerKey !== ownerKey(owner) || grant.expiresAt <= this.now()) {
      throw failure(
        "permission_denied",
        "Select the target session in the native host picker before sending.",
      );
    }
    const target = await this.targetForOwner(owner, grant.target.sessionId);
    if (JSON.stringify(target) !== JSON.stringify(grant.target)) {
      throw failure(
        "permission_denied",
        "The selected session's workspace or runtime changed; select it again.",
      );
    }
    return target;
  }

  async revokeGrant(ownerValue: SelectedSessionOwner, grantId: string): Promise<void> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    const grant = this.grants.get(grantId);
    if (grant && grant.ownerKey !== ownerKey(owner))
      throw failure("permission_denied", "Session grant belongs to another application owner.");
    this.grants.delete(grantId);
  }

  async send(
    ownerValue: SelectedSessionOwner,
    request: unknown,
    signal?: AbortSignal,
    /** Host-only job scope; not accepted in capability inputs. */
    jobId?: string,
  ): Promise<SelectedSessionReceipt> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    const normalized = normalizeSend(request);
    const epoch = this.ownerEpochs.get(ownerKey(owner)) ?? 0;
    signal?.throwIfAborted();
    const target = await this.resolveGrant(owner, normalized.grantId);
    if (jobId) await this.assertJobActive(jobId, owner, target);
    if (normalized.attachmentHandles?.length && !this.options.resolveAttachments) {
      throw failure("unsupported", "Authorized attachment delivery is unavailable on this host.");
    }
    const envelope: DeliveryEnvelope = {
      version: 1,
      owner,
      target,
      requestId: normalized.requestId,
      ...(jobId ? { jobId } : {}),
      message: normalized.message,
      ...(normalized.context !== undefined ? { context: normalized.context } : {}),
      ...(normalized.attachmentHandles?.length
        ? { attachmentHandles: normalized.attachmentHandles }
        : {}),
    };
    const messageId = requestMessageId(owner, normalized.requestId);
    const content = JSON.stringify(envelope);
    const existing = this.options.outbox.get(messageId);
    if (existing && existing.content !== content) throw requestConflict();
    signal?.throwIfAborted();
    await this.options.outbox.enqueue({
      messageId,
      idempotencyKey: messageId,
      source: ownerKey(owner),
      sourceLabel: owner.extensionId,
      target: target.sessionId,
      kind: "selected-session",
      deliveryMode: "queue",
      content,
    });
    // A competing invocation can win between the lookup and the durable enqueue.
    if (this.options.outbox.get(messageId)?.content !== content) throw requestConflict();
    if (jobId && !(await this.options.isJobActive?.(jobId, owner, target))) {
      await this.options.outbox.cancelBeforeBackendAcceptance(
        messageId,
        ownerKey(owner),
        target.sessionId,
      );
      throw failure("permission_denied", "The application job was revoked during acceptance.");
    }
    if (epoch !== (this.ownerEpochs.get(ownerKey(owner)) ?? 0)) {
      await this.options.outbox.cancelBeforeBackendAcceptance(
        messageId,
        ownerKey(owner),
        target.sessionId,
      );
      throw failure(
        "permission_denied",
        "The application was revoked while this request was being accepted.",
      );
    }
    return this.read(owner, normalized.requestId);
  }

  async read(
    ownerValue: SelectedSessionOwner,
    requestId: string,
    afterCursor?: string,
  ): Promise<SelectedSessionReceipt> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    await this.assertOwnerActive(owner);
    const message = this.ownedMessage(owner, requestId);
    return this.receipt(message, requestId, afterCursor);
  }

  async wait(
    ownerValue: SelectedSessionOwner,
    requestId: string,
    afterCursor: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SelectedSessionReceipt> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
      throw failure("invalid_input", "timeoutMs must be an integer from 0 to 30000.");
    }
    signal?.throwIfAborted();
    const initial = await this.read(ownerValue, requestId, afterCursor);
    if (!timeoutMs || initial.cursor !== afterCursor || TERMINAL.has(initial.state)) return initial;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Cancelled"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", abort);
      };
      const unsubscribe = this.watch(initial.messageId, finish);
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else {
        const latest = this.options.outbox.get(initial.messageId);
        if (latest && this.receipt(latest, requestId).cursor !== initial.cursor) finish();
      }
    });
    return this.read(ownerValue, requestId, afterCursor);
  }

  async cancel(
    ownerValue: SelectedSessionOwner,
    requestId: string,
  ): Promise<SelectedSessionReceipt> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    await this.assertOwnerActive(owner);
    const message = this.ownedMessage(owner, requestId);
    await this.options.outbox.cancelBeforeBackendAcceptance(
      message.messageId,
      message.source,
      message.target,
    );
    const receipt = await this.read(owner, requestId);
    if (!TERMINAL.has(receipt.state)) {
      throw failure(
        "already_dispatched",
        "This request has started; cancellation cannot interrupt the selected session's active turn.",
      );
    }
    return receipt;
  }

  /** Stop only a request submitted by this owner, never an unrelated user turn. */
  async stop(ownerValue: SelectedSessionOwner, requestId: string): Promise<SelectedSessionReceipt> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    await this.assertOwnerActive(owner);
    const message = this.ownedMessage(owner, requestId);
    await this.options.outbox.cancelBeforeBackendAcceptance(
      message.messageId,
      message.source,
      message.target,
    );
    const receipt = await this.read(owner, requestId);
    if (TERMINAL.has(receipt.state)) return receipt;
    const target = await this.targetForOwner(owner, receipt.targetSessionId);
    if (
      !this.options.sessions.cancelOwnedTurn ||
      !(await this.options.sessions.cancelOwnedTurn(target.sessionId, message.messageId))
    ) {
      throw failure(
        "turn_changed",
        "This application's request is no longer the active turn. No other turn was stopped.",
      );
    }
    return this.read(owner, requestId);
  }

  /** Cancel this job's pending requests without affecting other jobs or ordinary UI sends. */
  async revokeJob(jobId: string): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const message of this.options.outbox.list()) {
      if (message.kind !== "selected-session") continue;
      let envelope: DeliveryEnvelope;
      try {
        envelope = parseEnvelope(message);
      } catch {
        continue;
      }
      if (envelope.jobId === jobId)
        pending.push(
          this.options.outbox.cancelBeforeBackendAcceptance(
            message.messageId,
            message.source,
            message.target,
          ),
        );
    }
    await Promise.all(pending);
  }

  async deliver(
    message: Readonly<AgentMessageRecord>,
    control: AgentMessageDeliveryContext,
  ): Promise<AgentMessageDeliveryResult> {
    const result = await this.deliverCore(message, control);
    // CF-05: exactly one terminal chunk per delivery attempt's stream —
    // "pending" is a retry, not an outcome, and an unparseable envelope has
    // no owner/requestId to correlate with.
    if (result.state !== "pending") {
      try {
        const envelope = parseEnvelope(message);
        this.emitStreamChunk(envelope.owner, {
          requestId: envelope.requestId,
          streamSequence: ++this.bufferFor(message.messageId).sequence,
          kind: result.state === "processed" ? "status" : "error",
          text: result.state === "processed" ? "processed" : (result.error ?? result.state),
          terminal: true,
          terminalState: result.state,
        });
      } catch {
        // No correlation possible; the pull path still reports the outcome.
      }
    }
    return result;
  }

  private async deliverCore(
    message: Readonly<AgentMessageRecord>,
    control: AgentMessageDeliveryContext,
  ): Promise<AgentMessageDeliveryResult> {
    let envelope: DeliveryEnvelope;
    try {
      envelope = parseEnvelope(message);
    } catch {
      return { state: "dead-letter", error: "The persisted selected-session request is invalid." };
    }
    let target: SelectedSessionTarget;
    try {
      await this.assertOwnerActive(envelope.owner);
      target = await this.targetForOwner(envelope.owner, envelope.target.sessionId);
      if (envelope.jobId) await this.assertJobActive(envelope.jobId, envelope.owner, target);
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "permission_denied")
        return { state: "cancelled", error: error.message };
      throw error;
    }
    if (JSON.stringify(target) !== JSON.stringify(envelope.target)) {
      return { state: "cancelled", error: "Selected session workspace or runtime changed." };
    }
    if (this.options.sessions.isSessionBusy(target.sessionId)) {
      return { state: "pending", retryAfterMs: 1000, attemptConsumed: false };
    }
    let resolved:
      | Awaited<ReturnType<NonNullable<SelectedSessionDeliveryOptions["resolveAttachments"]>>>
      | undefined;
    if (envelope.attachmentHandles?.length) {
      if (!this.options.resolveAttachments)
        return { state: "dead-letter", error: "Authorized attachment delivery is unavailable." };
      try {
        resolved = await this.options.resolveAttachments({
          owner: envelope.owner,
          target,
          handles: envelope.attachmentHandles,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          ["permission_denied", "invalid_input", "unsupported"].includes(
            String(Reflect.get(error, "code")),
          )
        )
          return { state: "dead-letter", error: error.message };
        throw error;
      }
    }
    try {
      if (
        resolved &&
        (resolved.attachments.length !== envelope.attachmentHandles?.length ||
          resolved.attachments.some(
            (attachment) =>
              attachment.type !== "file" ||
              !attachment.path ||
              !Number.isSafeInteger(attachment.byteLength) ||
              attachment.byteLength < 0,
          ) ||
          resolved.attachments.reduce((sum, attachment) => sum + attachment.byteLength, 0) >
            MAX_ATTACHMENT_BYTES)
      ) {
        return {
          state: "dead-letter",
          error: "Attachments exceed delivery limits or could not all be resolved.",
        };
      }
      const result = await this.options.sessions.sendAndCollect(
        envelope.message +
          (envelope.context !== undefined ? `\n\n${wrapUntrusted("mcp", envelope.context)}` : ""),
        300_000,
        (event) => this.onProgress(message.messageId, envelope, event),
        target.sessionId,
        resolved?.attachments.map(({ type, path, displayName }) => ({
          type,
          path,
          ...(displayName ? { displayName } : {}),
        })),
        {
          clientMessageId: message.messageId,
          agentMessage: {
            source: message.source,
            sourceLabel: envelope.owner.extensionId,
            kind: "selected-session",
            deliveryMode: "queue",
            sequence: message.sequence,
            messageId: message.messageId,
            idempotencyKey: message.idempotencyKey,
            target: target.sessionId,
          },
          deliveryMode: "queue",
          disableConnectionLostRetry: true,
          onBackendDispatchStarting: async () => {
            await this.assertOwnerActive(envelope.owner);
            if (envelope.jobId) await this.assertJobActive(envelope.jobId, envelope.owner, target);
            const latestTarget = await this.targetForOwner(envelope.owner, target.sessionId);
            if (JSON.stringify(latestTarget) !== JSON.stringify(target))
              throw failure("permission_denied", "Selected session changed before dispatch.");
            await control.markBackendAccepted();
          },
          onBackendDelivered: control.markBackendDelivered,
        },
      );
      if (result.kind === "timeout") {
        return {
          state: "delivery-unknown",
          error:
            "Response collection timed out after dispatch; the request will not be sent again.",
        };
      }
      return { state: "processed", response: result.text };
    } finally {
      try {
        await resolved?.dispose?.();
      } catch {
        log.with({ messageId: message.messageId }).warn("Attachment lease cleanup failed");
      }
    }
  }

  async subscribe(
    ownerValue: SelectedSessionOwner,
    requestId: string,
    listener: (receipt: SelectedSessionReceipt) => void,
  ): Promise<() => void> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    const receipt = await this.read(owner, requestId);
    let active = true;
    const unsubscribe = this.watch(receipt.messageId, () => {
      void this.read(owner, requestId)
        .then((next) => {
          if (active) listener(next);
        })
        .catch(() => {});
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }

  private watch(messageId: string, listener: () => void): () => void {
    const listeners = this.observers.get(messageId) ?? new Set();
    listeners.add(listener);
    this.observers.set(messageId, listeners);
    const unsubscribe = this.options.outbox.subscribe(messageId, listener);
    return () => {
      unsubscribe();
      listeners.delete(listener);
      if (!listeners.size) this.observers.delete(messageId);
    };
  }

  private ownedMessage(owner: SelectedSessionOwner, requestId: string): AgentMessageRecord {
    boundedText(requestId, "requestId", 256);
    const message = this.options.outbox.get(requestMessageId(owner, requestId));
    if (!message || message.kind !== "selected-session" || message.source !== ownerKey(owner)) {
      throw failure("not_found", "Delivery request was not found for this application owner.");
    }
    return message;
  }

  private receipt(
    message: AgentMessageRecord,
    requestId: string,
    afterCursor?: string,
  ): SelectedSessionReceipt {
    const buffer = this.progress.get(message.messageId);
    const eventCursor = `${message.messageId}:${buffer?.epoch ?? "durable"}`;
    const sequence = buffer?.sequence ?? 0;
    const cursor = `${eventCursor}:${sequence}:${message.state}`;
    const prefix = `${eventCursor}:`;
    const afterSequence = afterCursor?.startsWith(prefix)
      ? Number(afterCursor.slice(prefix.length).split(":")[0])
      : -1;
    const oldest = buffer?.events[0]?.sequence ?? sequence;
    const reset =
      afterCursor !== undefined &&
      (!afterCursor.startsWith(prefix) ||
        afterSequence < oldest - 1 ||
        afterSequence > sequence ||
        !Number.isInteger(afterSequence));
    const response = message.response ?? buffer?.text ?? "";
    return {
      requestId,
      messageId: message.messageId,
      targetSessionId: message.target,
      ...(message.backendAcceptedAt ? { turnId: message.messageId } : {}),
      state: message.state,
      response: response.slice(0, MAX_RESPONSE),
      responseTruncated:
        response.length > MAX_RESPONSE ||
        (message.response === undefined && buffer?.truncated === true),
      cursor,
      reset,
      events:
        buffer?.events
          .filter((event) => reset || event.sequence > afterSequence)
          .map((event) => ({ ...event })) ?? [],
      ...(message.lastError ? { error: message.lastError } : {}),
    };
  }

  private bufferFor(messageId: string): ProgressBuffer {
    let buffer = this.progress.get(messageId);
    if (!buffer) {
      if (this.progress.size >= MAX_BUFFERS)
        this.progress.delete(this.progress.keys().next().value!);
      buffer = { epoch: randomUUID(), sequence: 0, text: "", truncated: false, events: [] };
      this.progress.set(messageId, buffer);
    }
    return buffer;
  }

  private emitStreamChunk(owner: SelectedSessionOwner, chunk: SelectedSessionStreamChunk): void {
    try {
      this.options.onStreamChunk?.(owner, {
        ...chunk,
        ...(chunk.text !== undefined ? { text: chunk.text.slice(0, STREAM_CHUNK_MAX_TEXT) } : {}),
      });
    } catch {
      // A push listener failure must never affect the delivery itself.
    }
  }

  private onProgress(messageId: string, envelope: DeliveryEnvelope, event: TurnEvent): void {
    let progress: Omit<SelectedSessionProgress, "sequence">;
    let replacement: string | undefined;
    if (event.type === "turn:text-delta")
      progress = { type: "text", text: event.delta.slice(0, MAX_RESPONSE) };
    else if (
      event.type === "turn:message-committed" &&
      event.message.role === "assistant" &&
      event.message.content
    ) {
      replacement = event.message.content;
      progress = { type: "status", text: "Assistant response committed" };
    } else if (event.type === "turn:status")
      progress = { type: "status", text: event.status?.slice(0, 1000) ?? "" };
    else if (event.type === "turn:error")
      progress = { type: event.retrying ? "retry" : "error", text: event.error.slice(0, 1000) };
    else return;
    const buffer = this.bufferFor(messageId);
    if (progress.type === "retry") {
      buffer.text = "";
      buffer.truncated = false;
    } else if (replacement !== undefined || progress.type === "text") {
      const next = replacement ?? buffer.text + (progress.text ?? "");
      buffer.truncated =
        (replacement === undefined && buffer.truncated) ||
        next.length > MAX_RESPONSE ||
        (event.type === "turn:text-delta" && event.delta.length > MAX_RESPONSE);
      buffer.text = next.slice(0, MAX_RESPONSE);
    }
    buffer.events.push({ ...progress, sequence: ++buffer.sequence });
    this.emitStreamChunk(envelope.owner, {
      requestId: envelope.requestId,
      streamSequence: buffer.sequence,
      kind: progress.type,
      ...(progress.text !== undefined ? { text: progress.text } : {}),
      terminal: false,
    });
    while (
      buffer.events.length > MAX_EVENTS ||
      buffer.events.reduce((sum, item) => sum + (item.text?.length ?? 0), 0) > MAX_RESPONSE
    )
      buffer.events.shift();
    for (const listener of this.observers.get(messageId) ?? []) listener();
  }

  private async assertOwnerActive(owner: SelectedSessionOwner): Promise<void> {
    if (!(await this.options.isOwnerActive(owner)))
      throw failure("permission_denied", "The extension application owner is inactive.");
  }

  private async assertJobActive(
    jobId: string,
    owner: SelectedSessionOwner,
    target: SelectedSessionTarget,
  ): Promise<void> {
    if (!(await this.options.isJobActive?.(jobId, owner, target)))
      throw failure(
        "permission_denied",
        "The application job is disarmed or requires re-arm after restart.",
      );
  }

  private async targetForOwner(
    owner: SelectedSessionOwner,
    sessionId: string,
  ): Promise<SelectedSessionTarget> {
    boundedText(sessionId, "targetSessionId", 256);
    const target = await this.options.getTarget(sessionId);
    if (
      !target ||
      target.sessionId !== sessionId ||
      target.runtimeId !== this.options.currentRuntimeId()
    ) {
      throw failure(
        "permission_denied",
        "The selected session is unavailable in the current runtime.",
      );
    }
    if (owner.applicationScope !== "user" && target.workspaceName !== owner.workspaceName) {
      throw failure(
        "permission_denied",
        "The selected session is outside this application's workspace.",
      );
    }
    return {
      sessionId: target.sessionId,
      workspaceName: target.workspaceName,
      runtimeId: target.runtimeId,
    };
  }
}

export function normalizeSelectedSessionOwner(value: unknown): SelectedSessionOwner {
  const owner = record(value);
  assertKeys(owner, [
    "extensionId",
    "applicationId",
    "workspaceName",
    "applicationScope",
    "sessionId",
  ]);
  const applicationScope = owner.applicationScope;
  if (
    applicationScope !== undefined &&
    applicationScope !== "user" &&
    applicationScope !== "workspace"
  )
    throw failure("invalid_input", "Invalid application scope.");
  if (applicationScope && owner.sessionId !== undefined)
    throw failure("invalid_input", "Persistent application owners cannot include a session ID.");
  return {
    extensionId: boundedText(owner.extensionId, "extensionId", 256),
    applicationId: boundedText(owner.applicationId, "applicationId", 256),
    workspaceName: boundedText(owner.workspaceName, "workspaceName", 1024),
    ...(applicationScope
      ? { applicationScope }
      : { sessionId: boundedText(owner.sessionId, "sessionId", 256) }),
  };
}

function normalizeSend(value: unknown): SelectedSessionSendRequest {
  const request = record(value);
  assertKeys(request, ["grantId", "requestId", "message", "context", "attachmentHandles"]);
  if (
    request.attachmentHandles !== undefined &&
    (!Array.isArray(request.attachmentHandles) || request.attachmentHandles.length > MAX_HANDLES)
  )
    throw failure("invalid_input", "At most eight attachment handles are allowed.");
  return {
    grantId: boundedText(request.grantId, "grantId", 256),
    requestId: boundedText(request.requestId, "requestId", 256),
    message: boundedText(request.message, "message", MAX_TEXT),
    ...(request.context !== undefined
      ? { context: boundedText(request.context, "context", MAX_TEXT) }
      : {}),
    ...(Array.isArray(request.attachmentHandles)
      ? {
          attachmentHandles: request.attachmentHandles.map((handle) =>
            boundedText(handle, "attachmentHandle", 256),
          ),
        }
      : {}),
  };
}

function parseEnvelope(message: Readonly<AgentMessageRecord>): DeliveryEnvelope {
  const value = JSON.parse(message.content) as unknown;
  const envelope = record(value);
  assertKeys(envelope, [
    "version",
    "jobId",
    "owner",
    "target",
    "requestId",
    "message",
    "context",
    "attachmentHandles",
  ]);
  const owner = normalizeSelectedSessionOwner(envelope.owner);
  const target = record(envelope.target);
  assertKeys(target, ["sessionId", "workspaceName", "runtimeId"]);
  const request = normalizeSend({
    grantId: "persisted",
    requestId: envelope.requestId,
    message: envelope.message,
    ...(envelope.context !== undefined ? { context: envelope.context } : {}),
    ...(envelope.attachmentHandles !== undefined
      ? { attachmentHandles: envelope.attachmentHandles }
      : {}),
  });
  if (
    envelope.version !== 1 ||
    message.kind !== "selected-session" ||
    message.deliveryMode !== "queue" ||
    message.source !== ownerKey(owner) ||
    message.messageId !== requestMessageId(owner, request.requestId) ||
    target.sessionId !== message.target
  )
    throw failure("invalid_input", "Invalid persisted selected-session request.");
  return {
    version: 1,
    owner,
    target: {
      sessionId: boundedText(target.sessionId, "sessionId", 256),
      workspaceName: boundedText(target.workspaceName, "workspaceName", 1024),
      runtimeId: boundedText(target.runtimeId, "runtimeId", 256),
    },
    requestId: request.requestId,
    ...(envelope.jobId !== undefined ? { jobId: boundedText(envelope.jobId, "jobId", 256) } : {}),
    message: request.message,
    ...(request.context !== undefined ? { context: request.context } : {}),
    ...(request.attachmentHandles ? { attachmentHandles: request.attachmentHandles } : {}),
  };
}

function ownerKey(owner: SelectedSessionOwner): string {
  return `selected-session-owner:${createHash("sha256").update(JSON.stringify(owner)).digest("hex")}`;
}
function requestMessageId(owner: SelectedSessionOwner, requestId: string): string {
  return `selected-session:${createHash("sha256")
    .update(JSON.stringify([ownerKey(owner), requestId]))
    .digest("hex")}`;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure("invalid_input", "Expected an object.");
  return Object.fromEntries(Object.entries(value));
}
function assertKeys(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw failure("invalid_input", "Unexpected request property.");
}
function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw failure("invalid_input", `${field} must contain 1 to ${max} characters.`);
  return value;
}
function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
function requestConflict(): Error {
  return failure(
    "conflict",
    "This request ID was already used with different content or a different target.",
  );
}
