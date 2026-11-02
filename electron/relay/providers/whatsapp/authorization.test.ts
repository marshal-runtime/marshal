import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
} from "../../../../common/relay-contract";
import {
  type AuthorizedWhatsAppInbound,
  InMemoryWhatsAppInboundIdempotencyStore,
  WhatsAppAuthorizationGate,
  type WhatsAppInboundIdempotencyStore,
  type WhatsAppMediaDownloadAuthorization,
  type WhatsAppMediaDownloadAuthorizationScope,
  type WhatsAppMediaDownloadAuthorizationSink,
  withWhatsAppMediaDownloadAuthorization,
  withWhatsAppMediaPipelineAuthorization,
  type WhatsAppOperationTokenVerifier,
  type WhatsAppProviderEnvelope,
  WHATSAPP_RELAY_PROVIDER_ID,
} from "./authorization";
import {
  WhatsAppIdentityBindingStore,
  type WhatsAppIdentityAssertion,
  type WhatsAppIdentityBindingRevisionAnchor,
  type WhatsAppProviderIdentityBindingEvidenceVerifier,
} from "./identity-binding-store";

const ALLOWED_CONVERSATION = "120363000000000001@g.us";
const OTHER_CONVERSATION = "120363000000000002@g.us";
const AUTHORIZED_PN = "15551234567@s.whatsapp.net";
const ACCOUNT_ID = parseRelayAccountId("account-1");
const RECEIVED_AT = "2026-08-07T02:00:00.000Z";
const EXPLICIT_EVIDENCE = {
  source: "explicit-authorization",
  version: 1,
} as const;

type StringContentLoader = () => Promise<string>;
type StringDispatcher = (inbound: AuthorizedWhatsAppInbound<string>) => Promise<string>;

describe("WhatsAppAuthorizationGate", () => {
  let tempDirectory: string;
  let identityStore: WhatsAppIdentityBindingStore;
  let authorizedBindingId: string;
  let revisionAnchor: WhatsAppIdentityBindingRevisionAnchor;
  let protectedRevision: number | null;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-authorization-"));
    protectedRevision = null;
    revisionAnchor = {
      read: () => protectedRevision,
      compareAndAdvance: (expectedRevision, nextRevision) => {
        if (protectedRevision !== expectedRevision) return false;
        protectedRevision = nextRevision;
        return true;
      },
    };
    identityStore = WhatsAppIdentityBindingStore.open({
      filePath: path.join(tempDirectory, "identity-bindings.json"),
      keyMaterial: randomBytes(32),
      revisionAnchor,
    });
    authorizedBindingId = identityStore.authorizeIdentity({
      pnJid: AUTHORIZED_PN,
      evidence: EXPLICIT_EVIDENCE,
    }).bindingId;
  });

  afterEach(() => {
    identityStore.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("implements the canonical inbound authorization port shape", async () => {
    const gate = createProductionGate();
    expect(WHATSAPP_RELAY_PROVIDER_ID).toBe("whatsapp-baileys");
    const request = {
      address: {
        providerId: WHATSAPP_RELAY_PROVIDER_ID,
        accountId: ACCOUNT_ID,
        conversationId: parseRelayConversationId(ALLOWED_CONVERSATION),
      },
      providerMessageId: parseRelayMessageId("canonical-message"),
      sender: { primaryId: AUTHORIZED_PN },
      receivedAt: RECEIVED_AT,
    };

    await expect(gate.authorize(request)).resolves.toEqual({
      ok: true,
      value: {
        address: request.address,
        providerMessageId: request.providerMessageId,
        senderPrimaryId: AUTHORIZED_PN,
        policyId: "whatsapp-managed-groups-v1",
        decidedAt: RECEIVED_AT,
        decision: "allow",
        reason: "managed-group",
      },
    });
    await expect(
      gate.authorize({
        ...request,
        address: {
          ...request.address,
          conversationId: parseRelayConversationId(OTHER_CONVERSATION),
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { decision: "deny", reason: "conversation-not-managed" },
    });
    await expect(
      gate.authorize({
        ...request,
        address: {
          ...request.address,
          accountId: parseRelayAccountId("other-account"),
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid-request",
        message: "The relay authorization request is invalid for this account.",
        retryable: false,
      },
    });
  });

  it("decides from metadata without loading content for unrelated chats or identities", async () => {
    const gate = createProductionGate();
    const loadUnrelated = vi.fn<StringContentLoader>(async () => "private unrelated content");
    const loadUnknown = vi.fn<StringContentLoader>(async () => "private unknown content");
    const loadFromMe = vi.fn<StringContentLoader>(async () => "private self content");
    const loadSpoofed = vi.fn<StringContentLoader>(async () => "private spoofed content");
    const dispatch = vi.fn<StringDispatcher>(async () => "sent");

    await expect(
      gate.processInbound(
        {
          envelope: envelope({ conversationId: OTHER_CONVERSATION }),
          loadContent: loadUnrelated,
        },
        dispatch,
      ),
    ).resolves.toEqual({ status: "denied", reason: "conversation-not-allowed" });
    await expect(
      gate.processInbound(
        {
          envelope: envelope({
            sender: { senderJid: "15550009999@s.whatsapp.net" },
            providerMessageId: "message-unknown",
          }),
          loadContent: loadUnknown,
        },
        dispatch,
      ),
    ).resolves.toEqual({ status: "denied", reason: "identity-unknown" });
    await expect(
      gate.processInbound(
        {
          envelope: envelope({ fromMe: true, providerMessageId: "message-from-me" }),
          loadContent: loadFromMe,
        },
        dispatch,
      ),
    ).resolves.toEqual({ status: "denied", reason: "from-me" });
    const spoofed = envelope({ providerMessageId: "message-spoofed-metadata" });
    await expect(
      gate.processInbound(
        {
          envelope: {
            ...spoofed,
            request: {
              ...spoofed.request,
              sender: { primaryId: "15550007777@s.whatsapp.net" },
            },
          },
          loadContent: loadSpoofed,
        },
        dispatch,
      ),
    ).resolves.toEqual({ status: "denied", reason: "invalid-envelope" });

    expect(loadUnrelated).not.toHaveBeenCalled();
    expect(loadUnknown).not.toHaveBeenCalled();
    expect(loadFromMe).not.toHaveBeenCalled();
    expect(loadSpoofed).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails closed for unknown PN/LID pairs and conflicting identity evidence", async () => {
    const conflictingLid = "999999999@lid";
    identityStore.authorizeIdentity({
      lidJid: conflictingLid,
      evidence: EXPLICIT_EVIDENCE,
    });
    const gate = createProductionGate();
    const loadUnknown = vi.fn<StringContentLoader>(async () => "unknown pair content");
    const loadConflict = vi.fn<StringContentLoader>(async () => "conflicting pair content");
    const dispatch = vi.fn<StringDispatcher>(async () => "sent");

    await expect(
      gate.processInbound(
        {
          envelope: envelope({
            providerMessageId: "message-unknown-pair",
            sender: {
              senderJid: "15550008888@s.whatsapp.net",
              pnJid: "15550008888@s.whatsapp.net",
              lidJid: "888888888@lid",
              bindingEvidence: { source: "provider-pn-lid", version: 1 },
            },
          }),
          loadContent: loadUnknown,
        },
        dispatch,
      ),
    ).resolves.toEqual({ status: "denied", reason: "identity-unknown" });
    await expect(
      gate.processInbound(
        {
          envelope: envelope({
            providerMessageId: "message-conflict",
            sender: {
              senderJid: AUTHORIZED_PN,
              pnJid: AUTHORIZED_PN,
              lidJid: conflictingLid,
              bindingEvidence: { source: "provider-pn-lid", version: 1 },
            },
          }),
          loadContent: loadConflict,
        },
        dispatch,
      ),
    ).resolves.toEqual({ status: "denied", reason: "identity-conflict" });

    expect(loadUnknown).not.toHaveBeenCalled();
    expect(loadConflict).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("binds PN/LID only after an injected verifier authenticates the exact evidence", async () => {
    const lidJid = "777777777@lid";
    const inboundEnvelope = envelope({
      providerMessageId: "message-verified-pair",
      sender: {
        senderJid: AUTHORIZED_PN,
        pnJid: AUTHORIZED_PN,
        lidJid,
        bindingEvidence: { source: "provider-pn-lid", version: 1 },
      },
    });
    const unverifiedLoader = vi.fn<StringContentLoader>(async () => "unverified content");
    const verifiedLoader = vi.fn<StringContentLoader>(async () => "verified content");
    const dispatch = vi.fn<StringDispatcher>(async () => "sent");

    await expect(
      createProductionGate().processInbound(
        { envelope: inboundEnvelope, loadContent: unverifiedLoader },
        dispatch,
      ),
    ).resolves.toEqual({
      status: "denied",
      reason: "identity-evidence-verification-required",
    });
    expect(unverifiedLoader).not.toHaveBeenCalled();

    const verifyIdentityBindingEvidence = vi.fn<WhatsAppProviderIdentityBindingEvidenceVerifier>(
      async (request) =>
        request.pnJid === AUTHORIZED_PN &&
        request.lidJid === lidJid &&
        request.scope.providerMessageId === "message-verified-pair",
    );
    await expect(
      createProductionGate({ verifyIdentityBindingEvidence }).processInbound(
        { envelope: inboundEnvelope, loadContent: verifiedLoader },
        dispatch,
      ),
    ).resolves.toMatchObject({ status: "dispatched" });
    expect(verifyIdentityBindingEvidence).toHaveBeenCalledOnce();
    expect(identityStore.resolveIdentity({ senderJid: lidJid })).toMatchObject({
      status: "authorized",
      binding: { bindingId: authorizedBindingId, hasPn: true, hasLid: true },
    });
  });

  it("keeps enrollment isolated with no agent listener and rejects every chat JID", async () => {
    const gate = new WhatsAppAuthorizationGate({
      mode: "enrollment",
      account: { providerId: WHATSAPP_RELAY_PROVIDER_ID, accountId: ACCOUNT_ID },
    });
    const loadContent = vi.fn<StringContentLoader>(async () => "enrollment content");
    const dispatch = vi.fn<StringDispatcher>(async () => "sent");

    expect(gate.createAgentListener(dispatch)).toBeUndefined();
    expect(gate.allowsRemoteCapability("steering")).toBe(false);
    await expect(
      gate.authorize({
        address: {
          providerId: WHATSAPP_RELAY_PROVIDER_ID,
          accountId: ACCOUNT_ID,
          conversationId: parseRelayConversationId(ALLOWED_CONVERSATION),
        },
        providerMessageId: parseRelayMessageId("enrollment-message"),
        sender: { primaryId: AUTHORIZED_PN },
        receivedAt: RECEIVED_AT,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { decision: "deny", reason: "account-disabled" },
    });
    await expect(
      gate.processInbound({ envelope: envelope(), loadContent }, dispatch),
    ).resolves.toEqual({ status: "denied", reason: "enrollment-isolated" });
    expect(loadContent).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("denies remote permission approval even with a valid operation token", async () => {
    const verifyOperationToken = vi.fn<WhatsAppOperationTokenVerifier>(async () => true);
    const gate = createProductionGate({ verifyOperationToken });
    const loadContent = vi.fn<StringContentLoader>(async () => "yes");
    const dispatch = vi.fn<StringDispatcher>(async () => "sent");

    expect(gate.allowsRemoteCapability("notification")).toBe(true);
    expect(gate.allowsRemoteCapability("steering")).toBe(true);
    expect(gate.allowsRemoteCapability("permission-approval")).toBe(false);
    await expect(
      gate.processInbound(
        {
          envelope: envelope({
            action: {
              kind: "operation",
              operationId: "permission-operation",
              capability: "permission-approval",
              token: "valid-token",
            },
          }),
          loadContent,
        },
        dispatch,
      ),
    ).resolves.toEqual({ status: "denied", reason: "remote-permission-denied" });
    expect(verifyOperationToken).not.toHaveBeenCalled();
    expect(loadContent).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("authenticates callback tokens before loading and again before dispatch", async () => {
    const validToken = "callback-secret-token";
    const verifyOperationToken = vi.fn<WhatsAppOperationTokenVerifier>(
      async ({ token }) => token === validToken,
    );
    const gate = createProductionGate({ verifyOperationToken });
    const invalidLoader = vi.fn<StringContentLoader>(async () => "invalid callback content");
    const validLoader = vi.fn<StringContentLoader>(async () => "valid callback content");
    const dispatch = vi.fn<StringDispatcher>(async ({ content }) => `processed:${content}`);

    await expect(
      gate.processInbound(
        {
          envelope: envelope({
            providerMessageId: "message-invalid-callback",
            action: {
              kind: "callback",
              callbackId: "callback-invalid",
              capability: "notification",
              token: "invalid",
            },
          }),
          loadContent: invalidLoader,
        },
        dispatch,
      ),
    ).resolves.toEqual({ status: "denied", reason: "authentication-rejected" });
    expect(invalidLoader).not.toHaveBeenCalled();

    await expect(
      gate.processInbound(
        {
          envelope: envelope({
            providerMessageId: "message-valid-callback",
            action: {
              kind: "callback",
              callbackId: "callback-valid",
              capability: "notification",
              token: validToken,
            },
          }),
          loadContent: validLoader,
        },
        dispatch,
      ),
    ).resolves.toMatchObject({
      status: "dispatched",
      authorization: {
        account: {
          providerId: WHATSAPP_RELAY_PROVIDER_ID,
          accountId: ACCOUNT_ID,
        },
        decision: {
          decision: "allow",
          reason: "managed-group",
          policyId: "whatsapp-managed-groups-v1",
        },
        identityBindingId: authorizedBindingId,
        capability: "notification",
        actionKind: "callback",
      },
      value: "processed:valid callback content",
    });
    expect(
      verifyOperationToken.mock.calls
        .map(([request]) => request)
        .filter((request) => request.token === validToken)
        .map((request) => request.phase),
    ).toEqual(["accept", "preload", "dispatch"]);
    expect(dispatch.mock.calls[0][0].envelope.action).toEqual({
      kind: "callback",
      callbackId: "callback-valid",
      capability: "notification",
    });
    expect(JSON.stringify(dispatch.mock.calls[0][0])).not.toContain(validToken);
  });

  it("deduplicates reconnect delivery before loading content", async () => {
    const idempotencyStore = new InMemoryWhatsAppInboundIdempotencyStore();
    const firstGate = createProductionGate({ idempotencyStore });
    const reconnectedGate = createProductionGate({ idempotencyStore });
    const firstLoader = vi.fn<StringContentLoader>(async () => "first content");
    const duplicateLoader = vi.fn<StringContentLoader>(async () => "duplicate content");
    const dispatch = vi.fn<StringDispatcher>(async () => "sent");
    const inboundEnvelope = envelope({ providerMessageId: "reconnect-message" });

    await expect(
      firstGate.processInbound({ envelope: inboundEnvelope, loadContent: firstLoader }, dispatch),
    ).resolves.toMatchObject({ status: "dispatched" });
    await expect(
      reconnectedGate.processInbound(
        { envelope: inboundEnvelope, loadContent: duplicateLoader },
        dispatch,
      ),
    ).resolves.toEqual({ status: "denied", reason: "duplicate" });

    expect(firstLoader).toHaveBeenCalledOnce();
    expect(duplicateLoader).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("issues in-memory media capabilities bound to the accepted message", async () => {
    let nowMs = Date.parse(RECEIVED_AT);
    let firstInbound: AuthorizedWhatsAppInbound<string> | undefined;
    let secondInbound: AuthorizedWhatsAppInbound<string> | undefined;
    let firstMedia: WhatsAppMediaDownloadAuthorization | undefined;
    let firstScope: WhatsAppMediaDownloadAuthorizationScope | undefined;
    let secondMedia: WhatsAppMediaDownloadAuthorization | undefined;
    const inboundEnvelope = envelope({ providerMessageId: "media-message" });
    const firstGate = createProductionGate({
      now: () => nowMs,
      createMediaAcceptanceToken: () => "media-acceptance-token-1",
      mediaDownloadAuthorizationSink: {
        accept: (authorization, scope) => {
          firstMedia = authorization;
          firstScope = scope;
        },
      },
    });
    const secondGate = createProductionGate({
      now: () => nowMs,
      createMediaAcceptanceToken: () => "media-acceptance-token-2",
      mediaDownloadAuthorizationSink: {
        accept: (authorization) => {
          secondMedia = authorization;
        },
      },
    });

    const firstResult = await firstGate.processInbound(
      { envelope: inboundEnvelope, loadContent: async () => "first media message" },
      async (inbound) => {
        firstInbound = inbound;
        return "sent";
      },
    );
    const secondResult = await secondGate.processInbound(
      { envelope: inboundEnvelope, loadContent: async () => "second media message" },
      async (inbound) => {
        secondInbound = inbound;
        return "sent";
      },
    );
    if (!firstInbound || !secondInbound || !firstMedia || !firstScope || !secondMedia) {
      throw new Error("Expected authorized media dispatches.");
    }

    expect(firstMedia).toMatchObject({
      acceptanceToken: "media-acceptance-token-1",
      decision: firstInbound.authorization.decision,
    });
    expect(secondMedia.acceptanceToken).toBe("media-acceptance-token-2");
    expect(firstInbound.authorization.idempotencyKey).toBe(
      secondInbound.authorization.idempotencyKey,
    );
    expect(firstInbound.authorization.idempotencyKey).not.toContain(firstMedia.acceptanceToken);
    expect(JSON.stringify(firstResult)).not.toContain("media-acceptance-token-1");
    expect(JSON.stringify(secondResult)).not.toContain("media-acceptance-token-2");
    expect(JSON.stringify(firstInbound)).not.toContain("media-acceptance-token-1");
    expect(
      fs.readFileSync(path.join(tempDirectory, "identity-bindings.json"), "utf8"),
    ).not.toContain("media-acceptance-token");

    expect(firstGate.verifyMediaDownloadAuthorization(firstMedia, firstScope)).toBe(true);
    expect(
      firstGate.verifyAuthorizedMediaDownload({
        authorization: firstMedia,
        message: firstScope,
      }),
    ).toBe(true);
    const download = vi.fn<
      (request: {
        authorization: WhatsAppMediaDownloadAuthorization;
        message: WhatsAppMediaDownloadAuthorizationScope;
        mediaId: string;
      }) => Promise<string>
    >(async ({ mediaId }) => `downloaded:${mediaId}`);
    const downloadAuthorized = withWhatsAppMediaDownloadAuthorization(firstGate, download);
    await expect(
      downloadAuthorized({
        authorization: firstMedia,
        message: firstScope,
        mediaId: "media-1",
      }),
    ).resolves.toBe("downloaded:media-1");
    await expect(
      downloadAuthorized({
        authorization: {
          ...firstMedia,
          acceptanceToken: "fabricated-token",
        },
        message: firstScope,
        mediaId: "media-2",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(download).toHaveBeenCalledOnce();

    const cachedResult = vi.fn<
      (request: {
        authorization: WhatsAppMediaDownloadAuthorization;
        message: WhatsAppMediaDownloadAuthorizationScope;
        mediaId: string;
      }) => Promise<string>
    >(async () => "cached-media-result");
    const processMediaInbound = withWhatsAppMediaPipelineAuthorization(firstGate, cachedResult);
    await expect(
      processMediaInbound({
        authorization: {
          ...firstMedia,
          acceptanceToken: "fabricated-cache-token",
        },
        message: firstScope,
        mediaId: "media-cache-hit",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(cachedResult).not.toHaveBeenCalled();
    expect(
      firstGate.verifyMediaDownloadAuthorization(firstMedia, {
        ...firstScope,
        providerMessageId: parseRelayMessageId("other-media-message"),
      }),
    ).toBe(false);
    expect(
      firstGate.verifyMediaDownloadAuthorization(firstMedia, {
        ...firstScope,
        address: {
          ...firstScope.address,
          conversationId: parseRelayConversationId(OTHER_CONVERSATION),
        },
      }),
    ).toBe(false);
    expect(
      firstGate.verifyMediaDownloadAuthorization(firstMedia, {
        ...firstScope,
        account: {
          ...firstScope.account,
          accountId: parseRelayAccountId("other-account"),
        },
      }),
    ).toBe(false);
    expect(secondGate.verifyMediaDownloadAuthorization(firstMedia, firstScope)).toBe(false);
    expect(
      secondGate.verifyAuthorizedMediaDownload({
        authorization: firstMedia,
        message: firstScope,
      }),
    ).toBe(false);
    expect(
      firstGate.verifyMediaDownloadAuthorization(
        {
          ...firstMedia,
          decision: {
            ...firstMedia.decision,
            providerMessageId: parseRelayMessageId("tampered-decision-message"),
          },
        },
        firstScope,
      ),
    ).toBe(false);

    nowMs += 5 * 60 * 1000 + 1;
    expect(firstGate.verifyMediaDownloadAuthorization(firstMedia, firstScope)).toBe(false);
  });

  it("rechecks authorization after claiming before loading content", async () => {
    const idempotencyStore: WhatsAppInboundIdempotencyStore = {
      async claim() {
        identityStore.revokeIdentity(authorizedBindingId);
        return true;
      },
      markDispatchStarted() {},
      abortBeforeDispatch() {},
      complete() {},
      release() {},
    };
    const gate = createProductionGate({ idempotencyStore });
    const loadContent = vi.fn<StringContentLoader>(async () => "must remain unloaded");
    const dispatch = vi.fn<StringDispatcher>(async () => "sent");

    await expect(
      gate.processInbound({ envelope: envelope(), loadContent }, dispatch),
    ).resolves.toEqual({
      status: "denied",
      reason: "preload-authorization-changed",
    });
    expect(loadContent).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reauthorizes after persisting the dispatch-start phase", async () => {
    const backingStore = new InMemoryWhatsAppInboundIdempotencyStore();
    let aborted = 0;
    const idempotencyStore: WhatsAppInboundIdempotencyStore = {
      claim: (key) => backingStore.claim(key),
      markDispatchStarted: (key) => {
        backingStore.markDispatchStarted(key);
        identityStore.revokeIdentity(authorizedBindingId);
      },
      abortBeforeDispatch: (key) => {
        aborted += 1;
        backingStore.abortBeforeDispatch(key);
      },
      complete: (key) => backingStore.complete(key),
      release: (key) => backingStore.release(key),
    };
    const gate = createProductionGate({ idempotencyStore });
    const loadContent = vi.fn<StringContentLoader>(async () => "authorized before dispatch mark");
    const dispatch = vi.fn<StringDispatcher>(async () => "sent");

    await expect(
      gate.processInbound({ envelope: envelope(), loadContent }, dispatch),
    ).resolves.toEqual({
      status: "denied",
      reason: "dispatch-authorization-changed",
    });
    expect(loadContent).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(aborted).toBe(1);
  });

  it("pins the binding version through dispatch", async () => {
    const gate = createProductionGate();
    const loadContent = vi.fn<StringContentLoader>(async () => {
      identityStore.revokeIdentity(authorizedBindingId);
      identityStore.authorizeIdentity({
        pnJid: AUTHORIZED_PN,
        evidence: EXPLICIT_EVIDENCE,
      });
      return "content loaded before identity churn was observed";
    });
    const dispatch = vi.fn<StringDispatcher>(async () => "sent");

    await expect(
      gate.processInbound({ envelope: envelope(), loadContent }, dispatch),
    ).resolves.toEqual({
      status: "denied",
      reason: "dispatch-authorization-changed",
    });
    expect(loadContent).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retains an ambiguous idempotency claim once dispatch starts", async () => {
    const idempotencyStore = new InMemoryWhatsAppInboundIdempotencyStore();
    const gate = createProductionGate({ idempotencyStore });
    const firstLoader = vi.fn<StringContentLoader>(async () => "first attempt");
    const retryLoader = vi.fn<StringContentLoader>(async () => "retry attempt");
    let sideEffects = 0;
    const dispatch = vi.fn<StringDispatcher>(async () => {
      sideEffects += 1;
      throw new Error("transport outcome unknown");
    });
    const inboundEnvelope = envelope({ providerMessageId: "ambiguous-dispatch" });

    await expect(
      gate.processInbound({ envelope: inboundEnvelope, loadContent: firstLoader }, dispatch),
    ).rejects.toThrow("transport outcome unknown");
    await expect(
      gate.processInbound({ envelope: inboundEnvelope, loadContent: retryLoader }, dispatch),
    ).resolves.toEqual({ status: "denied", reason: "duplicate" });
    expect(sideEffects).toBe(1);
    expect(retryLoader).not.toHaveBeenCalled();
  });

  function createProductionGate(
    overrides: Partial<{
      idempotencyStore: WhatsAppInboundIdempotencyStore;
      verifyOperationToken: WhatsAppOperationTokenVerifier;
      verifyIdentityBindingEvidence: WhatsAppProviderIdentityBindingEvidenceVerifier;
      now: () => number;
      createMediaAcceptanceToken: () => string;
      mediaDownloadAuthorizationSink: WhatsAppMediaDownloadAuthorizationSink;
    }> = {},
  ): WhatsAppAuthorizationGate {
    const idempotencyStore =
      overrides.idempotencyStore ?? new InMemoryWhatsAppInboundIdempotencyStore();
    const mediaDownloadAuthorizationSink = overrides.mediaDownloadAuthorizationSink ?? {
      accept() {},
    };
    return new WhatsAppAuthorizationGate({
      mode: "production",
      account: { providerId: WHATSAPP_RELAY_PROVIDER_ID, accountId: ACCOUNT_ID },
      allowedConversationJids: [ALLOWED_CONVERSATION],
      identityStore,
      now: () => Date.parse(RECEIVED_AT),
      ...overrides,
      idempotencyStore,
      mediaDownloadAuthorizationSink,
    });
  }
});

interface EnvelopeOverrides {
  readonly accountId?: string;
  readonly conversationId?: string;
  readonly providerMessageId?: string;
  readonly fromMe?: boolean;
  readonly sender?: WhatsAppIdentityAssertion;
  readonly receivedAt?: string;
  readonly action?: WhatsAppProviderEnvelope["action"];
}

function envelope(overrides: EnvelopeOverrides = {}): WhatsAppProviderEnvelope {
  const identity = overrides.sender ?? { senderJid: AUTHORIZED_PN };
  const alternateIds = [identity.pnJid, identity.lidJid].filter(
    (value): value is string => value !== undefined && value !== identity.senderJid,
  );
  return {
    request: {
      address: {
        providerId: WHATSAPP_RELAY_PROVIDER_ID,
        accountId: parseRelayAccountId(overrides.accountId ?? ACCOUNT_ID),
        conversationId: parseRelayConversationId(overrides.conversationId ?? ALLOWED_CONVERSATION),
      },
      providerMessageId: parseRelayMessageId(overrides.providerMessageId ?? "message-1"),
      sender: {
        primaryId: identity.senderJid,
        ...(alternateIds.length === 0 ? {} : { alternateIds }),
      },
      receivedAt: overrides.receivedAt ?? RECEIVED_AT,
    },
    fromMe: overrides.fromMe ?? false,
    identity,
    ...(overrides.action === undefined ? {} : { action: overrides.action }),
  };
}
