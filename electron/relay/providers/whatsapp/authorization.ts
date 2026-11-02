import { createHash, randomBytes } from "node:crypto";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
  type RelayAccountId,
  type RelayAddress,
  type RelayIdentity,
  type RelayMessageId,
  type RelayProviderId,
} from "../../../../common/relay-contract";
import {
  verifyWhatsAppProviderIdentityBindingEvidence,
  type ResolveWhatsAppIdentityOptions,
  type WhatsAppIdentityAssertion,
  type WhatsAppIdentityResolution,
  type WhatsAppProviderIdentityBindingEvidenceVerifier,
} from "./identity-binding-store";

const AUTHORIZATION_VERSION = 1;
const DEFAULT_IDEMPOTENCY_ENTRIES = 4096;
const MAX_OPAQUE_ID_BYTES = 1024;
const MAX_TOKEN_BYTES = 8192;
const MEDIA_ACCEPTANCE_TOKEN_BYTES = 32;
const MEDIA_ACCEPTANCE_TTL_MS = 5 * 60 * 1000;
const MAX_MEDIA_ACCEPTANCE_TOKENS = 4096;
const WHATSAPP_AUTHORIZATION_POLICY_ID = "whatsapp-managed-groups-v1";

export type WhatsAppAuthorizationMode = "enrollment" | "production";
export const WHATSAPP_RELAY_PROVIDER_ID = parseRelayProviderId("whatsapp-baileys");

// Unified HEAD predates the canonical experience-contract modules. Keep this
// private structural mirror aligned until integration replaces it with imports.
type RelayTimestamp = string;
type RelayIdempotencyKey = string;

interface RelayAccountScope {
  readonly providerId: RelayProviderId;
  readonly accountId: RelayAccountId;
}

type RelayAuthorizationErrorCode = "invalid-request" | "unavailable" | "storage-failure";

interface RelayExperienceFailure<
  Code extends RelayAuthorizationErrorCode = RelayAuthorizationErrorCode,
> {
  readonly code: Code;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

type RelayExperienceResult<Value, Code extends RelayAuthorizationErrorCode> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly error: RelayExperienceFailure<Code>;
    };

interface RelayInboundAuthorizationRequest {
  readonly address: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly sender: RelayIdentity;
  readonly receivedAt: RelayTimestamp;
}

type RelayInboundAllowReason = "trusted-sender" | "managed-group";
type RelayInboundDenyReason =
  | "sender-not-authorized"
  | "conversation-not-managed"
  | "account-disabled";

interface RelayInboundAuthorizationDecisionBase {
  readonly address: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly senderPrimaryId: string;
  readonly policyId: string;
  readonly decidedAt: RelayTimestamp;
}

type RelayInboundAuthorizationDecision =
  | (RelayInboundAuthorizationDecisionBase & {
      readonly decision: "allow";
      readonly reason: RelayInboundAllowReason;
    })
  | (RelayInboundAuthorizationDecisionBase & {
      readonly decision: "deny";
      readonly reason: RelayInboundDenyReason;
    });

interface RelayInboundAuthorizationPort {
  authorize(
    request: RelayInboundAuthorizationRequest,
  ): Promise<RelayExperienceResult<RelayInboundAuthorizationDecision, RelayAuthorizationErrorCode>>;
}

export type WhatsAppRemoteCapability = "notification" | "steering" | "permission-approval";

export type WhatsAppAuthenticatedAction =
  | {
      readonly kind: "callback";
      readonly callbackId: string;
      readonly capability: WhatsAppRemoteCapability;
      readonly token: string;
    }
  | {
      readonly kind: "operation";
      readonly operationId: string;
      readonly capability: WhatsAppRemoteCapability;
      readonly token: string;
    };

export type WhatsAppInboundAction =
  | {
      readonly kind: "message";
      readonly capability?: "steering";
    }
  | WhatsAppAuthenticatedAction;

export interface WhatsAppProviderEnvelope {
  readonly request: RelayInboundAuthorizationRequest;
  readonly fromMe: boolean;
  readonly identity: WhatsAppIdentityAssertion;
  readonly action?: WhatsAppInboundAction;
}

export interface WhatsAppLazyInbound<TContent> {
  readonly envelope: WhatsAppProviderEnvelope;
  readonly loadContent: () => Promise<TContent>;
}

export type WhatsAppAuthorizationReasonCode =
  | "enrollment-isolated"
  | "from-me"
  | "invalid-envelope"
  | "conversation-not-allowed"
  | "identity-unknown"
  | "identity-not-authorized"
  | "identity-conflict"
  | "identity-invalid"
  | "identity-evidence-required"
  | "identity-evidence-unsupported"
  | "identity-evidence-verification-required"
  | "identity-evidence-rejected"
  | "identity-evidence-error"
  | "identity-store-unavailable"
  | "authentication-required"
  | "authentication-rejected"
  | "authentication-error"
  | "remote-permission-denied"
  | "duplicate"
  | "preload-authorization-changed"
  | "dispatch-authorization-changed";

export interface WhatsAppDispatchAuthorization {
  readonly authorizationVersion: typeof AUTHORIZATION_VERSION;
  readonly account: RelayAccountScope;
  readonly idempotencyKey: RelayIdempotencyKey;
  readonly decision: RelayInboundAuthorizationDecision;
  readonly identityBindingId: string;
  readonly identityBindingVersion: number;
  readonly capability: "notification" | "steering";
  readonly actionKind: "message" | "callback" | "operation";
}

export interface WhatsAppMediaDownloadAuthorization {
  readonly acceptanceToken: string;
  readonly decision: RelayInboundAuthorizationDecision;
  readonly expiresAt?: RelayTimestamp;
}

export interface WhatsAppMediaDownloadAuthorizationScope {
  readonly account: RelayAccountScope;
  readonly address: RelayAddress;
  readonly providerMessageId: RelayMessageId;
}

export interface WhatsAppMediaDownloadAuthorizationVerifier {
  verifyMediaDownloadAuthorization(
    authorization: WhatsAppMediaDownloadAuthorization,
    scope: WhatsAppMediaDownloadAuthorizationScope,
  ): boolean;
  verifyAuthorizedMediaDownload(
    request: WhatsAppAuthorizedMediaDownloadAuthorizationRequest,
  ): boolean;
}

export interface WhatsAppAuthorizedMediaDownloadAuthorizationRequest {
  readonly authorization: WhatsAppMediaDownloadAuthorization;
  readonly message: {
    readonly account: RelayAccountScope;
    readonly address: RelayAddress;
    readonly providerMessageId: RelayMessageId;
  };
}

export class WhatsAppMediaDownloadAuthorizationError extends Error {
  readonly code = "UNAUTHORIZED";

  constructor() {
    super("WhatsApp media download authorization was rejected.");
    this.name = "WhatsAppMediaDownloadAuthorizationError";
  }
}

export function withWhatsAppMediaDownloadAuthorization<
  TRequest extends WhatsAppAuthorizedMediaDownloadAuthorizationRequest,
  TResult,
>(
  verifier: WhatsAppMediaDownloadAuthorizationVerifier,
  download: (request: TRequest) => Promise<TResult>,
): (request: TRequest) => Promise<TResult> {
  return withWhatsAppMediaPipelineAuthorization(verifier, download);
}

export function withWhatsAppMediaPipelineAuthorization<
  TRequest extends WhatsAppAuthorizedMediaDownloadAuthorizationRequest,
  TResult,
>(
  verifier: WhatsAppMediaDownloadAuthorizationVerifier,
  processInbound: (request: TRequest) => Promise<TResult>,
): (request: TRequest) => Promise<TResult> {
  return async (request) => {
    if (!verifier.verifyAuthorizedMediaDownload(request)) {
      throw new WhatsAppMediaDownloadAuthorizationError();
    }
    return await processInbound(request);
  };
}

export interface WhatsAppMediaDownloadAuthorizationSink {
  accept(
    authorization: WhatsAppMediaDownloadAuthorization,
    scope: WhatsAppMediaDownloadAuthorizationScope,
  ): void;
}

export type AuthorizedWhatsAppAction =
  | {
      readonly kind: "message";
      readonly capability: "steering";
    }
  | {
      readonly kind: "callback";
      readonly callbackId: string;
      readonly capability: "notification" | "steering";
    }
  | {
      readonly kind: "operation";
      readonly operationId: string;
      readonly capability: "notification" | "steering";
    };

export interface AuthorizedWhatsAppProviderEnvelope {
  readonly request: RelayInboundAuthorizationRequest;
  readonly fromMe: false;
  readonly action: AuthorizedWhatsAppAction;
}

export interface AuthorizedWhatsAppInbound<TContent> {
  readonly envelope: AuthorizedWhatsAppProviderEnvelope;
  readonly authorization: WhatsAppDispatchAuthorization;
  readonly content: TContent;
}

export type WhatsAppAuthorizedDispatcher<TContent, TResult> = (
  inbound: AuthorizedWhatsAppInbound<TContent>,
) => Promise<TResult>;

export type WhatsAppAgentListener<TContent, TResult> = (
  inbound: WhatsAppLazyInbound<TContent>,
) => Promise<WhatsAppAuthorizationDispatchResult<TResult>>;

export type WhatsAppAuthorizationDispatchResult<TResult> =
  | {
      readonly status: "dispatched";
      readonly authorization: WhatsAppDispatchAuthorization;
      readonly value: TResult;
    }
  | {
      readonly status: "denied";
      readonly reason: WhatsAppAuthorizationReasonCode;
    };

export interface WhatsAppIdentityBindingResolver {
  resolveIdentity(
    assertion: WhatsAppIdentityAssertion,
    options?: ResolveWhatsAppIdentityOptions,
  ): WhatsAppIdentityResolution;
}

export interface WhatsAppOperationTokenVerificationRequest {
  readonly phase: "accept" | "preload" | "dispatch";
  readonly authenticationKind: "callback" | "operation";
  readonly authenticationId: string;
  readonly token: string;
  readonly capability: WhatsAppRemoteCapability;
  readonly account: RelayAccountScope;
  readonly providerId: "whatsapp-baileys";
  readonly accountId: string;
  readonly conversationId: string;
  readonly providerMessageId: string;
  readonly sender: WhatsAppIdentityAssertion;
  readonly idempotencyKey: string;
}

export type WhatsAppOperationTokenVerifier = (
  request: WhatsAppOperationTokenVerificationRequest,
) => boolean | Promise<boolean>;

export interface WhatsAppInboundIdempotencyStore {
  claim(idempotencyKey: RelayIdempotencyKey): boolean | Promise<boolean>;
  markDispatchStarted(idempotencyKey: RelayIdempotencyKey): void | Promise<void>;
  abortBeforeDispatch(idempotencyKey: RelayIdempotencyKey): void | Promise<void>;
  complete(idempotencyKey: RelayIdempotencyKey): void | Promise<void>;
  release(idempotencyKey: RelayIdempotencyKey): void | Promise<void>;
}

interface WhatsAppAuthorizationGateBaseOptions {
  readonly account: RelayAccountScope;
  readonly now?: () => number;
  readonly createMediaAcceptanceToken?: () => string;
  readonly verifyOperationToken?: WhatsAppOperationTokenVerifier;
  readonly verifyIdentityBindingEvidence?: WhatsAppProviderIdentityBindingEvidenceVerifier;
}

export type WhatsAppAuthorizationGateOptions =
  | (WhatsAppAuthorizationGateBaseOptions & {
      readonly mode: "enrollment";
      readonly allowedConversationJids?: never;
      readonly identityStore?: never;
      readonly idempotencyStore?: never;
      readonly mediaDownloadAuthorizationSink?: never;
    })
  | (WhatsAppAuthorizationGateBaseOptions & {
      readonly mode: "production";
      readonly allowedConversationJids: readonly string[];
      readonly identityStore: WhatsAppIdentityBindingResolver;
      readonly idempotencyStore: WhatsAppInboundIdempotencyStore;
      readonly mediaDownloadAuthorizationSink: WhatsAppMediaDownloadAuthorizationSink;
    });

interface NormalizedEnvelope {
  readonly envelope: WhatsAppProviderEnvelope;
  readonly action: RequiredMessageAction | WhatsAppAuthenticatedAction;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

interface RequiredMessageAction {
  readonly kind: "message";
  readonly capability: "steering";
}

interface AuthorizationPass {
  readonly normalized: NormalizedEnvelope;
  readonly relayDecision: RelayInboundAuthorizationDecision;
  readonly identityBindingId: string;
  readonly identityBindingVersion: number;
  readonly capability: "notification" | "steering";
  readonly actionKind: "message" | "callback" | "operation";
}

interface MediaAcceptanceRecord {
  readonly scope: WhatsAppMediaDownloadAuthorizationScope;
  readonly decisionDigest: string;
  readonly expiresAt: RelayTimestamp;
  readonly expiresAtMs: number;
}

type AuthorizationDecision =
  | {
      readonly status: "allowed";
      readonly pass: AuthorizationPass;
    }
  | {
      readonly status: "denied";
      readonly reason: Exclude<
        WhatsAppAuthorizationReasonCode,
        "duplicate" | "preload-authorization-changed" | "dispatch-authorization-changed"
      >;
    };

export class InMemoryWhatsAppInboundIdempotencyStore implements WhatsAppInboundIdempotencyStore {
  private readonly entries = new Map<string, "claimed" | "dispatching" | "completed">();

  constructor(private readonly maxCompletedEntries = DEFAULT_IDEMPOTENCY_ENTRIES) {
    if (
      !Number.isSafeInteger(maxCompletedEntries) ||
      maxCompletedEntries <= 0 ||
      maxCompletedEntries > 1_000_000
    ) {
      throw new TypeError("The WhatsApp idempotency entry limit is invalid.");
    }
  }

  claim(idempotencyKey: string): boolean {
    validateIdempotencyKey(idempotencyKey);
    if (this.entries.has(idempotencyKey)) return false;
    this.entries.set(idempotencyKey, "claimed");
    return true;
  }

  markDispatchStarted(idempotencyKey: string): void {
    validateIdempotencyKey(idempotencyKey);
    if (this.entries.get(idempotencyKey) !== "claimed") {
      throw new Error("The WhatsApp idempotency claim cannot enter dispatch.");
    }
    this.entries.set(idempotencyKey, "dispatching");
  }

  abortBeforeDispatch(idempotencyKey: string): void {
    validateIdempotencyKey(idempotencyKey);
    if (this.entries.get(idempotencyKey) !== "dispatching") {
      throw new Error("The WhatsApp idempotency dispatch cannot be aborted.");
    }
    this.entries.delete(idempotencyKey);
  }

  complete(idempotencyKey: string): void {
    validateIdempotencyKey(idempotencyKey);
    if (this.entries.get(idempotencyKey) !== "dispatching") {
      throw new Error("The WhatsApp idempotency dispatch is not active.");
    }
    this.entries.delete(idempotencyKey);
    this.entries.set(idempotencyKey, "completed");
    this.evictCompletedEntries();
  }

  release(idempotencyKey: string): void {
    validateIdempotencyKey(idempotencyKey);
    if (this.entries.get(idempotencyKey) === "claimed") {
      this.entries.delete(idempotencyKey);
    }
  }

  private evictCompletedEntries(): void {
    let completedEntries = 0;
    for (const state of this.entries.values()) {
      if (state === "completed") completedEntries += 1;
    }

    for (const [key, state] of this.entries) {
      if (completedEntries <= this.maxCompletedEntries) return;
      if (state === "completed") {
        this.entries.delete(key);
        completedEntries -= 1;
      }
    }
  }
}

export class WhatsAppAuthorizationGate
  implements RelayInboundAuthorizationPort, WhatsAppMediaDownloadAuthorizationVerifier
{
  readonly mode: WhatsAppAuthorizationMode;

  private readonly account: RelayAccountScope;
  private readonly allowedConversationJids: ReadonlySet<string>;
  private readonly identityStore: WhatsAppIdentityBindingResolver | undefined;
  private readonly idempotencyStore: WhatsAppInboundIdempotencyStore | undefined;
  private readonly verifyOperationToken: WhatsAppOperationTokenVerifier | undefined;
  private readonly verifyIdentityBindingEvidence:
    | WhatsAppProviderIdentityBindingEvidenceVerifier
    | undefined;
  private readonly now: () => number;
  private readonly createMediaAcceptanceToken: () => string;
  private readonly mediaAcceptanceTokens = new Map<string, MediaAcceptanceRecord>();
  private readonly mediaDownloadAuthorizationSink:
    | WhatsAppMediaDownloadAuthorizationSink
    | undefined;

  constructor(options: WhatsAppAuthorizationGateOptions) {
    this.mode = options.mode;
    this.account = validateAccountScope(options.account);
    this.verifyOperationToken = options.verifyOperationToken;
    this.verifyIdentityBindingEvidence = options.verifyIdentityBindingEvidence;
    this.now = options.now ?? Date.now;
    this.createMediaAcceptanceToken =
      options.createMediaAcceptanceToken ??
      (() => randomBytes(MEDIA_ACCEPTANCE_TOKEN_BYTES).toString("base64url"));

    if (options.mode === "enrollment") {
      this.allowedConversationJids = new Set();
      this.identityStore = undefined;
      this.idempotencyStore = undefined;
      this.mediaDownloadAuthorizationSink = undefined;
      return;
    }

    this.allowedConversationJids = new Set(
      options.allowedConversationJids.map(normalizeGroupConversationJid),
    );
    this.identityStore = options.identityStore;
    this.idempotencyStore = options.idempotencyStore;
    this.mediaDownloadAuthorizationSink = options.mediaDownloadAuthorizationSink;
  }

  async authorize(
    request: RelayInboundAuthorizationRequest,
  ): Promise<
    RelayExperienceResult<RelayInboundAuthorizationDecision, RelayAuthorizationErrorCode>
  > {
    const normalized = normalizeRelayAuthorizationRequest(request);
    if (!normalized || !accountScopesEqual(normalized.address, this.account)) {
      return authorizationFailure(
        "invalid-request",
        "The relay authorization request is invalid for this account.",
        false,
      );
    }
    if (this.mode === "enrollment") {
      return {
        ok: true,
        value: this.relayDecision(normalized, "deny", "account-disabled"),
      };
    }
    if (!this.allowedConversationJids.has(normalized.address.conversationId)) {
      return {
        ok: true,
        value: this.relayDecision(normalized, "deny", "conversation-not-managed"),
      };
    }

    const assertion = identityAssertionFromRelayIdentity(normalized.sender);
    if (!assertion) {
      return {
        ok: true,
        value: this.relayDecision(normalized, "deny", "sender-not-authorized"),
      };
    }

    let identity: WhatsAppIdentityResolution;
    try {
      identity = this.identityStore?.resolveIdentity(assertion) ?? { status: "unknown" };
    } catch {
      return authorizationFailure(
        "storage-failure",
        "WhatsApp identity authorization storage is unavailable.",
        true,
      );
    }
    return {
      ok: true,
      value:
        identity.status === "authorized"
          ? this.relayDecision(normalized, "allow", "managed-group")
          : this.relayDecision(normalized, "deny", "sender-not-authorized"),
    };
  }

  allowsRemoteCapability(capability: WhatsAppRemoteCapability): boolean {
    return this.mode === "production" && capability !== "permission-approval";
  }

  verifyMediaDownloadAuthorization(
    authorization: WhatsAppMediaDownloadAuthorization,
    scope: WhatsAppMediaDownloadAuthorizationScope,
  ): boolean {
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return false;
    this.pruneMediaAcceptanceTokens(nowMs);
    if (
      !isObjectRecord(authorization) ||
      !isRelayInboundAuthorizationDecision(authorization.decision) ||
      !isMediaAuthorizationScope(scope) ||
      normalizeBoundedString(authorization.acceptanceToken, 512) === undefined
    ) {
      return false;
    }

    const record = this.mediaAcceptanceTokens.get(authorization.acceptanceToken);
    if (
      !record ||
      record.expiresAtMs <= nowMs ||
      authorization.expiresAt !== record.expiresAt ||
      authorization.decision.decision !== "allow" ||
      mediaDecisionDigest(authorization.decision) !== record.decisionDigest ||
      !mediaAuthorizationScopesEqual(scope, record.scope) ||
      !sameRelayAddress(authorization.decision.address, scope.address) ||
      authorization.decision.providerMessageId !== scope.providerMessageId
    ) {
      return false;
    }
    return true;
  }

  verifyAuthorizedMediaDownload(
    request: WhatsAppAuthorizedMediaDownloadAuthorizationRequest,
  ): boolean {
    if (!isObjectRecord(request) || !isObjectRecord(request.message)) return false;
    return this.verifyMediaDownloadAuthorization(request.authorization, {
      account: request.message.account,
      address: request.message.address,
      providerMessageId: request.message.providerMessageId,
    });
  }

  createAgentListener<TContent, TResult>(
    dispatch: WhatsAppAuthorizedDispatcher<TContent, TResult>,
  ): WhatsAppAgentListener<TContent, TResult> | undefined {
    if (this.mode === "enrollment") return undefined;
    return (inbound) => this.processInbound(inbound, dispatch);
  }

  async processInbound<TContent, TResult>(
    inbound: WhatsAppLazyInbound<TContent>,
    dispatch: WhatsAppAuthorizedDispatcher<TContent, TResult>,
  ): Promise<WhatsAppAuthorizationDispatchResult<TResult>> {
    if (this.mode === "enrollment") {
      return { status: "denied", reason: "enrollment-isolated" };
    }
    if (!isObjectRecord(inbound) || typeof inbound.loadContent !== "function") {
      return { status: "denied", reason: "invalid-envelope" };
    }

    const accepted = await this.authorizeEnvelope(inbound.envelope, "accept");
    if (accepted.status === "denied") return accepted;

    const idempotencyStore = this.idempotencyStore;
    if (!idempotencyStore) return { status: "denied", reason: "invalid-envelope" };
    const { idempotencyKey } = accepted.pass.normalized;
    if (!(await idempotencyStore.claim(idempotencyKey))) {
      return { status: "denied", reason: "duplicate" };
    }

    let dispatchMarked = false;
    let dispatchStarted = false;
    try {
      const preloadDecision = await this.authorizeEnvelope(inbound.envelope, "preload");
      if (
        preloadDecision.status === "denied" ||
        !authorizationPassesMatch(accepted.pass, preloadDecision.pass)
      ) {
        return { status: "denied", reason: "preload-authorization-changed" };
      }

      const content = await inbound.loadContent();
      await idempotencyStore.markDispatchStarted(idempotencyKey);
      dispatchMarked = true;
      const dispatchDecision = await this.authorizeEnvelope(inbound.envelope, "dispatch");
      if (
        dispatchDecision.status === "denied" ||
        !authorizationPassesMatch(accepted.pass, dispatchDecision.pass)
      ) {
        return { status: "denied", reason: "dispatch-authorization-changed" };
      }

      const authorization: WhatsAppDispatchAuthorization = {
        authorizationVersion: AUTHORIZATION_VERSION,
        account: this.account,
        idempotencyKey,
        decision: dispatchDecision.pass.relayDecision,
        identityBindingId: dispatchDecision.pass.identityBindingId,
        identityBindingVersion: dispatchDecision.pass.identityBindingVersion,
        capability: dispatchDecision.pass.capability,
        actionKind: dispatchDecision.pass.actionKind,
      };
      const mediaDownloadAuthorization = this.issueMediaDownloadAuthorization(
        dispatchDecision.pass.relayDecision,
      );
      const mediaAuthorizationScope = mediaAuthorizationScopeFromDecision(
        this.account,
        dispatchDecision.pass.relayDecision,
      );
      try {
        if (!this.mediaDownloadAuthorizationSink) {
          throw new Error("WhatsApp media authorization delivery is unavailable.");
        }
        this.mediaDownloadAuthorizationSink.accept(
          mediaDownloadAuthorization,
          mediaAuthorizationScope,
        );
      } catch (error) {
        this.mediaAcceptanceTokens.delete(mediaDownloadAuthorization.acceptanceToken);
        throw error;
      }
      dispatchStarted = true;
      const value = await dispatch({
        envelope: authorizedEnvelope(dispatchDecision.pass),
        authorization,
        content,
      });
      await idempotencyStore.complete(idempotencyKey);
      return { status: "dispatched", authorization, value };
    } finally {
      if (!dispatchStarted) {
        if (dispatchMarked) await idempotencyStore.abortBeforeDispatch(idempotencyKey);
        else await idempotencyStore.release(idempotencyKey);
      }
    }
  }

  private async authorizeEnvelope(
    envelope: WhatsAppProviderEnvelope,
    phase: "accept" | "preload" | "dispatch",
  ): Promise<AuthorizationDecision> {
    const normalized = normalizeEnvelope(envelope);
    if (!normalized) return { status: "denied", reason: "invalid-envelope" };
    if (!accountScopesEqual(normalized.envelope.request.address, this.account)) {
      return { status: "denied", reason: "invalid-envelope" };
    }
    if (normalized.envelope.fromMe) return { status: "denied", reason: "from-me" };
    if (!this.allowedConversationJids.has(normalized.envelope.request.address.conversationId)) {
      return { status: "denied", reason: "conversation-not-allowed" };
    }
    if (normalized.action.capability === "permission-approval") {
      return { status: "denied", reason: "remote-permission-denied" };
    }
    const capability = normalized.action.capability;

    if (normalized.action.kind !== "message") {
      if (!this.verifyOperationToken) {
        return { status: "denied", reason: "authentication-required" };
      }
      try {
        const authenticated = await this.verifyOperationToken({
          phase,
          authenticationKind: normalized.action.kind,
          authenticationId:
            normalized.action.kind === "callback"
              ? normalized.action.callbackId
              : normalized.action.operationId,
          token: normalized.action.token,
          capability: normalized.action.capability,
          account: this.account,
          providerId: "whatsapp-baileys",
          accountId: normalized.envelope.request.address.accountId,
          conversationId: normalized.envelope.request.address.conversationId,
          providerMessageId: normalized.envelope.request.providerMessageId,
          sender: normalized.envelope.identity,
          idempotencyKey: normalized.idempotencyKey,
        });
        if (!authenticated) {
          return { status: "denied", reason: "authentication-rejected" };
        }
      } catch {
        return { status: "denied", reason: "authentication-error" };
      }
    }

    let identity: WhatsAppIdentityResolution;
    try {
      identity = this.identityStore?.resolveIdentity(normalized.envelope.identity) ?? {
        status: "unknown",
      };
    } catch {
      return { status: "denied", reason: "identity-store-unavailable" };
    }
    if (identity.status === "evidence-required") {
      if (normalized.envelope.identity.bindingEvidence === undefined) {
        return { status: "denied", reason: "identity-evidence-required" };
      }
      if (!this.verifyIdentityBindingEvidence) {
        return { status: "denied", reason: "identity-evidence-verification-required" };
      }

      let verifiedEvidence: Awaited<
        ReturnType<typeof verifyWhatsAppProviderIdentityBindingEvidence>
      >;
      try {
        verifiedEvidence = await verifyWhatsAppProviderIdentityBindingEvidence(
          normalized.envelope.identity,
          {
            providerId: "whatsapp-baileys",
            accountId: normalized.envelope.request.address.accountId,
            conversationId: normalized.envelope.request.address.conversationId,
            providerMessageId: normalized.envelope.request.providerMessageId,
          },
          this.verifyIdentityBindingEvidence,
        );
      } catch {
        return { status: "denied", reason: "identity-evidence-error" };
      }
      if (!verifiedEvidence) {
        return { status: "denied", reason: "identity-evidence-rejected" };
      }

      try {
        identity = this.identityStore?.resolveIdentity(normalized.envelope.identity, {
          verifiedBindingEvidence: verifiedEvidence,
        }) ?? { status: "unknown" };
      } catch {
        return { status: "denied", reason: "identity-store-unavailable" };
      }
    }
    if (identity.status !== "authorized") {
      return { status: "denied", reason: identityReason(identity.status) };
    }

    return {
      status: "allowed",
      pass: {
        normalized,
        relayDecision: this.relayDecision(normalized.envelope.request, "allow", "managed-group"),
        identityBindingId: identity.binding.bindingId,
        identityBindingVersion: identity.binding.bindingVersion,
        capability,
        actionKind: normalized.action.kind,
      },
    };
  }

  private issueMediaDownloadAuthorization(
    decision: RelayInboundAuthorizationDecision,
  ): WhatsAppMediaDownloadAuthorization {
    if (decision.decision !== "allow" || !accountScopesEqual(decision.address, this.account)) {
      throw new Error("WhatsApp media authorization requires an accepted relay decision.");
    }
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("WhatsApp media authorization requires a valid clock.");
    }
    this.pruneMediaAcceptanceTokens(nowMs);

    let acceptanceToken: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = this.createMediaAcceptanceToken();
      if (
        normalizeBoundedString(candidate, 512) !== undefined &&
        !this.mediaAcceptanceTokens.has(candidate)
      ) {
        acceptanceToken = candidate;
        break;
      }
    }
    if (!acceptanceToken) {
      throw new Error("WhatsApp media acceptance-token generation failed.");
    }

    while (this.mediaAcceptanceTokens.size >= MAX_MEDIA_ACCEPTANCE_TOKENS) {
      const oldest = this.mediaAcceptanceTokens.keys().next().value;
      if (typeof oldest !== "string") break;
      this.mediaAcceptanceTokens.delete(oldest);
    }
    const decidedAtMs = Date.parse(decision.decidedAt);
    if (!Number.isFinite(decidedAtMs)) {
      throw new Error("WhatsApp media authorization decision time is invalid.");
    }
    const expiresAtMs = Math.max(nowMs, decidedAtMs) + MEDIA_ACCEPTANCE_TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const scope = mediaAuthorizationScopeFromDecision(this.account, decision);
    this.mediaAcceptanceTokens.set(acceptanceToken, {
      scope,
      decisionDigest: mediaDecisionDigest(decision),
      expiresAt,
      expiresAtMs,
    });
    return Object.freeze({
      acceptanceToken,
      decision,
      expiresAt,
    });
  }

  private pruneMediaAcceptanceTokens(nowMs: number): void {
    for (const [token, record] of this.mediaAcceptanceTokens) {
      if (record.expiresAtMs <= nowMs) this.mediaAcceptanceTokens.delete(token);
    }
  }

  private relayDecision(
    request: RelayInboundAuthorizationRequest,
    decision: "allow",
    reason: RelayInboundAllowReason,
  ): RelayInboundAuthorizationDecision;
  private relayDecision(
    request: RelayInboundAuthorizationRequest,
    decision: "deny",
    reason: RelayInboundDenyReason,
  ): RelayInboundAuthorizationDecision;
  private relayDecision(
    request: RelayInboundAuthorizationRequest,
    decision: "allow" | "deny",
    reason: RelayInboundAllowReason | RelayInboundDenyReason,
  ): RelayInboundAuthorizationDecision {
    const base: RelayInboundAuthorizationDecisionBase = {
      address: Object.freeze({ ...request.address }),
      providerMessageId: request.providerMessageId,
      senderPrimaryId: request.sender.primaryId,
      policyId: WHATSAPP_AUTHORIZATION_POLICY_ID,
      decidedAt: new Date(this.now()).toISOString(),
    };
    return Object.freeze(
      decision === "allow"
        ? {
            ...base,
            decision,
            reason: reason === "trusted-sender" ? reason : "managed-group",
          }
        : {
            ...base,
            decision,
            reason:
              reason === "conversation-not-managed" || reason === "account-disabled"
                ? reason
                : "sender-not-authorized",
          },
    );
  }
}

function normalizeEnvelope(envelope: WhatsAppProviderEnvelope): NormalizedEnvelope | undefined {
  if (!isObjectRecord(envelope)) return undefined;
  const request = normalizeRelayAuthorizationRequest(envelope.request);
  if (!request) return undefined;
  const conversationId = tryNormalizeGroupConversationJid(request.address.conversationId);
  if (
    conversationId === undefined ||
    typeof envelope.fromMe !== "boolean" ||
    !isIdentityAssertion(envelope.identity) ||
    !relayIdentityMatchesAssertion(request.sender, envelope.identity)
  ) {
    return undefined;
  }

  const action = normalizeAction(envelope.action);
  if (!action) return undefined;
  const identity = copyIdentityAssertion(envelope.identity);
  const normalizedEnvelope: WhatsAppProviderEnvelope = {
    request: {
      ...request,
      address: {
        ...request.address,
        conversationId: parseRelayConversationId(conversationId),
      },
    },
    fromMe: envelope.fromMe,
    identity,
    action,
  };
  const idempotencyKey = buildIdempotencyKey(normalizedEnvelope);
  return {
    envelope: normalizedEnvelope,
    action,
    idempotencyKey,
    fingerprint: buildAuthorizationFingerprint(normalizedEnvelope, action),
  };
}

function normalizeRelayAuthorizationRequest(
  request: RelayInboundAuthorizationRequest,
): RelayInboundAuthorizationRequest | undefined {
  if (!isObjectRecord(request) || !isObjectRecord(request.address)) return undefined;
  const providerId = normalizeOpaqueId(request.address.providerId);
  const accountId = normalizeOpaqueId(request.address.accountId);
  const conversationId = normalizeOpaqueId(request.address.conversationId);
  const providerMessageId = normalizeOpaqueId(request.providerMessageId);
  const receivedAt = normalizeRelayTimestamp(request.receivedAt);
  const sender = normalizeRelayIdentity(request.sender);
  if (
    providerId === undefined ||
    accountId === undefined ||
    conversationId === undefined ||
    providerMessageId === undefined ||
    receivedAt === undefined ||
    sender === undefined
  ) {
    return undefined;
  }
  return {
    address: {
      providerId: parseRelayProviderId(providerId),
      accountId: parseRelayAccountId(accountId),
      conversationId: parseRelayConversationId(conversationId),
    },
    providerMessageId: parseRelayMessageId(providerMessageId),
    sender,
    receivedAt,
  };
}

function relayIdentityMatchesAssertion(
  identity: RelayIdentity,
  assertion: WhatsAppIdentityAssertion,
): boolean {
  const expected = relayIdentityFromAssertion(assertion);
  if (identity.primaryId !== expected.primaryId) return false;
  const actualAlternates = [...(identity.alternateIds ?? [])].sort();
  const expectedAlternates = [...(expected.alternateIds ?? [])].sort();
  return (
    actualAlternates.length === expectedAlternates.length &&
    actualAlternates.every((value, index) => value === expectedAlternates[index])
  );
}

function relayIdentityFromAssertion(assertion: WhatsAppIdentityAssertion): RelayIdentity {
  const alternateIds = [assertion.pnJid, assertion.lidJid].filter(
    (value): value is string => value !== undefined && value !== assertion.senderJid,
  );
  return {
    primaryId: assertion.senderJid,
    ...(alternateIds.length === 0 ? {} : { alternateIds }),
  };
}

function normalizeRelayIdentity(value: unknown): RelayIdentity | undefined {
  if (!isObjectRecord(value)) return undefined;
  const primaryId = normalizeBoundedString(value.primaryId, MAX_OPAQUE_ID_BYTES);
  if (primaryId === undefined) return undefined;
  let alternateIds: string[] | undefined;
  if (value.alternateIds !== undefined) {
    if (!Array.isArray(value.alternateIds) || value.alternateIds.length > 16) return undefined;
    alternateIds = [];
    for (const alternateId of value.alternateIds) {
      const normalized = normalizeBoundedString(alternateId, MAX_OPAQUE_ID_BYTES);
      if (normalized === undefined || alternateIds.includes(normalized)) return undefined;
      alternateIds.push(normalized);
    }
  }
  const displayName =
    value.displayName === undefined
      ? undefined
      : normalizeBoundedString(value.displayName, MAX_OPAQUE_ID_BYTES);
  if (value.displayName !== undefined && displayName === undefined) return undefined;
  return {
    primaryId,
    ...(alternateIds === undefined ? {} : { alternateIds }),
    ...(displayName === undefined ? {} : { displayName }),
  };
}

function identityAssertionFromRelayIdentity(
  identity: RelayIdentity,
): WhatsAppIdentityAssertion | undefined {
  const primaryKind = whatsAppIdentityKind(identity.primaryId);
  if (!primaryKind) return undefined;
  let pnJid = primaryKind === "pn" ? identity.primaryId.toLowerCase() : undefined;
  let lidJid = primaryKind === "lid" ? identity.primaryId.toLowerCase() : undefined;
  for (const alternateId of identity.alternateIds ?? []) {
    const kind = whatsAppIdentityKind(alternateId);
    if (!kind) continue;
    const normalized = alternateId.toLowerCase();
    if (kind === "pn") {
      if (pnJid !== undefined && pnJid !== normalized) return undefined;
      pnJid = normalized;
    } else {
      if (lidJid !== undefined && lidJid !== normalized) return undefined;
      lidJid = normalized;
    }
  }
  return {
    senderJid: identity.primaryId,
    ...(pnJid === undefined ? {} : { pnJid }),
    ...(lidJid === undefined ? {} : { lidJid }),
  };
}

function validateAccountScope(account: RelayAccountScope): RelayAccountScope {
  if (
    !isObjectRecord(account) ||
    account.providerId !== WHATSAPP_RELAY_PROVIDER_ID ||
    normalizeOpaqueId(account.accountId) === undefined
  ) {
    throw new TypeError("The WhatsApp authorization account scope is invalid.");
  }
  return Object.freeze({
    providerId: WHATSAPP_RELAY_PROVIDER_ID,
    accountId: parseRelayAccountId(account.accountId),
  });
}

function accountScopesEqual(address: RelayAddress, account: RelayAccountScope): boolean {
  return address.providerId === account.providerId && address.accountId === account.accountId;
}

function isMediaAuthorizationScope(
  value: unknown,
): value is WhatsAppMediaDownloadAuthorizationScope {
  return (
    isObjectRecord(value) &&
    isObjectRecord(value.account) &&
    isObjectRecord(value.address) &&
    value.account.providerId === WHATSAPP_RELAY_PROVIDER_ID &&
    value.address.providerId === value.account.providerId &&
    value.address.accountId === value.account.accountId &&
    normalizeOpaqueId(value.account.accountId) !== undefined &&
    normalizeOpaqueId(value.address.conversationId) !== undefined &&
    normalizeOpaqueId(value.providerMessageId) !== undefined
  );
}

function mediaAuthorizationScopesEqual(
  left: WhatsAppMediaDownloadAuthorizationScope,
  right: WhatsAppMediaDownloadAuthorizationScope,
): boolean {
  return (
    left.account.providerId === right.account.providerId &&
    left.account.accountId === right.account.accountId &&
    sameRelayAddress(left.address, right.address) &&
    left.providerMessageId === right.providerMessageId
  );
}

function mediaAuthorizationScopeFromDecision(
  account: RelayAccountScope,
  decision: RelayInboundAuthorizationDecision,
): WhatsAppMediaDownloadAuthorizationScope {
  return Object.freeze({
    account,
    address: decision.address,
    providerMessageId: decision.providerMessageId,
  });
}

function sameRelayAddress(left: RelayAddress, right: RelayAddress): boolean {
  return (
    left.providerId === right.providerId &&
    left.accountId === right.accountId &&
    left.conversationId === right.conversationId
  );
}

function isRelayInboundAuthorizationDecision(
  value: unknown,
): value is RelayInboundAuthorizationDecision {
  if (
    !isObjectRecord(value) ||
    !isObjectRecord(value.address) ||
    normalizeOpaqueId(value.address.providerId) === undefined ||
    normalizeOpaqueId(value.address.accountId) === undefined ||
    normalizeOpaqueId(value.address.conversationId) === undefined ||
    normalizeOpaqueId(value.providerMessageId) === undefined ||
    normalizeOpaqueId(value.senderPrimaryId) === undefined ||
    normalizeOpaqueId(value.policyId) === undefined ||
    normalizeRelayTimestamp(value.decidedAt) === undefined
  ) {
    return false;
  }
  return value.decision === "allow"
    ? value.reason === "trusted-sender" || value.reason === "managed-group"
    : value.decision === "deny" &&
        (value.reason === "sender-not-authorized" ||
          value.reason === "conversation-not-managed" ||
          value.reason === "account-disabled");
}

function mediaDecisionDigest(decision: RelayInboundAuthorizationDecision): string {
  const hash = createHash("sha256");
  updateHashPart(hash, decision.address.providerId);
  updateHashPart(hash, decision.address.accountId);
  updateHashPart(hash, decision.address.conversationId);
  updateHashPart(hash, decision.providerMessageId);
  updateHashPart(hash, decision.senderPrimaryId);
  updateHashPart(hash, decision.policyId);
  updateHashPart(hash, decision.decidedAt);
  updateHashPart(hash, decision.decision);
  updateHashPart(hash, decision.reason);
  return hash.digest("hex");
}

function authorizationFailure<Code extends RelayAuthorizationErrorCode>(
  code: Code,
  message: string,
  retryable: boolean,
): RelayExperienceResult<never, Code> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
    },
  };
}

function normalizeAction(
  action: WhatsAppInboundAction | undefined,
): RequiredMessageAction | WhatsAppAuthenticatedAction | undefined {
  if (action === undefined) return { kind: "message", capability: "steering" };
  if (!isObjectRecord(action)) return undefined;
  if (action.kind === "message") {
    if (action.capability !== undefined && action.capability !== "steering") return undefined;
    return { kind: "message", capability: "steering" };
  }
  if (action.kind !== "callback" && action.kind !== "operation") return undefined;
  if (!isRemoteCapability(action.capability)) return undefined;
  const token = normalizeBoundedString(action.token, MAX_TOKEN_BYTES);
  const authenticationId = normalizeOpaqueId(
    action.kind === "callback" ? action.callbackId : action.operationId,
  );
  if (token === undefined || authenticationId === undefined) return undefined;
  return action.kind === "callback"
    ? {
        kind: "callback",
        callbackId: authenticationId,
        capability: action.capability,
        token,
      }
    : {
        kind: "operation",
        operationId: authenticationId,
        capability: action.capability,
        token,
      };
}

function copyIdentityAssertion(assertion: WhatsAppIdentityAssertion): WhatsAppIdentityAssertion {
  return {
    senderJid: assertion.senderJid,
    ...(assertion.pnJid === undefined ? {} : { pnJid: assertion.pnJid }),
    ...(assertion.lidJid === undefined ? {} : { lidJid: assertion.lidJid }),
    ...(assertion.bindingEvidence === undefined
      ? {}
      : {
          bindingEvidence: {
            source: assertion.bindingEvidence.source,
            version: assertion.bindingEvidence.version,
          },
        }),
  };
}

function authorizationPassesMatch(left: AuthorizationPass, right: AuthorizationPass): boolean {
  return (
    left.identityBindingId === right.identityBindingId &&
    left.identityBindingVersion === right.identityBindingVersion &&
    left.capability === right.capability &&
    left.actionKind === right.actionKind &&
    left.normalized.idempotencyKey === right.normalized.idempotencyKey &&
    left.normalized.fingerprint === right.normalized.fingerprint
  );
}

function authorizedEnvelope(pass: AuthorizationPass): AuthorizedWhatsAppProviderEnvelope {
  const { envelope, action } = pass.normalized;
  let authorizedAction: AuthorizedWhatsAppAction;
  if (action.kind === "message") {
    authorizedAction = { kind: "message", capability: "steering" };
  } else if (action.kind === "callback") {
    authorizedAction = {
      kind: "callback",
      callbackId: action.callbackId,
      capability: pass.capability,
    };
  } else {
    authorizedAction = {
      kind: "operation",
      operationId: action.operationId,
      capability: pass.capability,
    };
  }
  return {
    request: envelope.request,
    fromMe: false,
    action: authorizedAction,
  };
}

function isIdentityAssertion(value: unknown): value is WhatsAppIdentityAssertion {
  if (!isObjectRecord(value)) return false;
  if (normalizeBoundedString(value.senderJid, MAX_OPAQUE_ID_BYTES) === undefined) return false;
  if (
    value.pnJid !== undefined &&
    normalizeBoundedString(value.pnJid, MAX_OPAQUE_ID_BYTES) === undefined
  ) {
    return false;
  }
  if (
    value.lidJid !== undefined &&
    normalizeBoundedString(value.lidJid, MAX_OPAQUE_ID_BYTES) === undefined
  ) {
    return false;
  }
  if (value.bindingEvidence !== undefined) {
    if (
      !isObjectRecord(value.bindingEvidence) ||
      normalizeBoundedString(value.bindingEvidence.source, 128) === undefined ||
      typeof value.bindingEvidence.version !== "number" ||
      !Number.isSafeInteger(value.bindingEvidence.version)
    ) {
      return false;
    }
  }
  return true;
}

function identityReason(
  status: Exclude<WhatsAppIdentityResolution["status"], "authorized">,
):
  | "identity-unknown"
  | "identity-not-authorized"
  | "identity-conflict"
  | "identity-invalid"
  | "identity-evidence-required"
  | "identity-evidence-unsupported" {
  switch (status) {
    case "unknown":
      return "identity-unknown";
    case "not-authorized":
      return "identity-not-authorized";
    case "conflict":
      return "identity-conflict";
    case "evidence-required":
      return "identity-evidence-required";
    case "evidence-unsupported":
      return "identity-evidence-unsupported";
    case "invalid":
      return "identity-invalid";
    default: {
      const exhaustiveStatus: never = status;
      throw new Error(`Unsupported identity resolution status: ${String(exhaustiveStatus)}`);
    }
  }
}

function buildIdempotencyKey(envelope: WhatsAppProviderEnvelope): RelayIdempotencyKey {
  const hash = createHash("sha256");
  updateHashPart(hash, String(AUTHORIZATION_VERSION));
  updateHashPart(hash, envelope.request.address.providerId);
  updateHashPart(hash, envelope.request.address.accountId);
  updateHashPart(hash, envelope.request.address.conversationId);
  updateHashPart(hash, envelope.request.providerMessageId);
  return `${WHATSAPP_RELAY_PROVIDER_ID}:v${AUTHORIZATION_VERSION}:${hash.digest("hex")}`;
}

function buildAuthorizationFingerprint(
  envelope: WhatsAppProviderEnvelope,
  action: RequiredMessageAction | WhatsAppAuthenticatedAction,
): string {
  const hash = createHash("sha256");
  updateHashPart(hash, envelope.request.address.providerId);
  updateHashPart(hash, envelope.request.address.accountId);
  updateHashPart(hash, envelope.request.address.conversationId);
  updateHashPart(hash, envelope.request.providerMessageId);
  updateHashPart(hash, String(envelope.fromMe));
  updateHashPart(hash, envelope.request.receivedAt);
  updateHashPart(hash, envelope.identity.senderJid);
  updateHashPart(hash, envelope.identity.pnJid ?? "");
  updateHashPart(hash, envelope.identity.lidJid ?? "");
  updateHashPart(hash, envelope.identity.bindingEvidence?.source ?? "");
  updateHashPart(hash, String(envelope.identity.bindingEvidence?.version ?? ""));
  updateHashPart(hash, action.kind);
  updateHashPart(hash, action.capability);
  if (action.kind === "callback") {
    updateHashPart(hash, action.callbackId);
    updateHashPart(hash, action.token);
  } else if (action.kind === "operation") {
    updateHashPart(hash, action.operationId);
    updateHashPart(hash, action.token);
  }
  return hash.digest("hex");
}

function updateHashPart(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length);
  hash.update(bytes);
}

function normalizeGroupConversationJid(value: string): string {
  const normalized = tryNormalizeGroupConversationJid(value);
  if (normalized === undefined) {
    throw new TypeError("Configured WhatsApp conversations must be canonical group JIDs.");
  }
  return normalized;
}

function tryNormalizeGroupConversationJid(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() !== value) return undefined;
  const normalized = value.toLowerCase();
  return /^[0-9]+(?:-[0-9]+)?@g\.us$/.test(normalized) ? normalized : undefined;
}

function normalizeOpaqueId(value: unknown): string | undefined {
  return normalizeBoundedString(value, MAX_OPAQUE_ID_BYTES);
}

function normalizeBoundedString(value: unknown, maxBytes: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    return undefined;
  }
  return value;
}

function normalizeRelayTimestamp(value: unknown): RelayTimestamp | undefined {
  const normalized = normalizeBoundedString(value, 128);
  if (normalized === undefined || !Number.isFinite(Date.parse(normalized))) return undefined;
  return normalized;
}

function whatsAppIdentityKind(value: unknown): "pn" | "lid" | undefined {
  if (typeof value !== "string" || value.trim() !== value) return undefined;
  const normalized = value.toLowerCase();
  if (/^[0-9]{1,32}@s\.whatsapp\.net$/.test(normalized)) return "pn";
  return /^[0-9]{1,32}@lid$/.test(normalized) ? "lid" : undefined;
}

function isRemoteCapability(value: unknown): value is WhatsAppRemoteCapability {
  return value === "notification" || value === "steering" || value === "permission-approval";
}

function validateIdempotencyKey(value: string): void {
  if (!/^whatsapp-baileys:v1:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("The WhatsApp idempotency key is invalid.");
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
