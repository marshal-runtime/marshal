import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  verifyWhatsAppProviderIdentityBindingEvidence,
  WhatsAppIdentityBindingConflictError,
  WhatsAppIdentityBindingStore,
  WhatsAppIdentityBindingStoreConfigurationError,
  WhatsAppIdentityBindingStoreIoError,
  WhatsAppIdentityBindingStoreRollbackError,
  WhatsAppIdentityBindingStoreWrongKeyError,
  type WhatsAppIdentityAssertion,
  type WhatsAppIdentityBindingRevisionAnchor,
  type VerifiedWhatsAppProviderIdentityBindingEvidence,
} from "./identity-binding-store";

const EXPLICIT_EVIDENCE = {
  source: "explicit-authorization",
  version: 1,
} as const;
const PROVIDER_EVIDENCE = {
  source: "provider-pn-lid",
  version: 1,
} as const;
const EVIDENCE_SCOPE = {
  providerId: "whatsapp-baileys",
  accountId: "account-1",
  conversationId: "120363000000000001@g.us",
  providerMessageId: "message-1",
} as const;

describe("WhatsAppIdentityBindingStore", () => {
  let tempDirectory: string;
  let filePath: string;
  let keyMaterial: Buffer;
  let revisionAnchor: WhatsAppIdentityBindingRevisionAnchor;
  let protectedRevision: number | null;
  let failAnchorAdvance: boolean;
  let failAfterAnchorAdvance: boolean;
  let stores: WhatsAppIdentityBindingStore[];

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-identity-bindings-"));
    filePath = path.join(tempDirectory, "identity-bindings.json");
    keyMaterial = randomBytes(32);
    protectedRevision = null;
    failAnchorAdvance = false;
    failAfterAnchorAdvance = false;
    revisionAnchor = {
      read: () => protectedRevision,
      compareAndAdvance: (expectedRevision, nextRevision) => {
        if (failAnchorAdvance) throw new Error("anchor unavailable");
        if (protectedRevision !== expectedRevision) return false;
        protectedRevision = nextRevision;
        if (failAfterAnchorAdvance) throw new Error("anchor outcome ambiguous");
        return true;
      },
    };
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("persists only keyed digests and recovers PN/LID bindings", async () => {
    const pnJid = "15551234567@s.whatsapp.net";
    const lidJid = "987654321@lid";
    const store = openStore();
    const authorized = store.authorizeIdentity({
      pnJid,
      evidence: EXPLICIT_EVIDENCE,
      authorizedAtMs: 10,
    });

    const assertion = {
      senderJid: pnJid,
      pnJid,
      lidJid,
      bindingEvidence: PROVIDER_EVIDENCE,
    };
    expect(store.resolveIdentity(assertion)).toEqual({ status: "evidence-required" });
    expect(
      store.resolveIdentity(assertion, {
        verifiedBindingEvidence: await verifyEvidence(assertion),
      }),
    ).toMatchObject({
      status: "authorized",
      binding: {
        bindingId: authorized.bindingId,
        hasPn: true,
        hasLid: true,
        evidenceSource: "provider-pn-lid",
      },
    });
    store.close();

    const persisted = fs.readFileSync(filePath, "utf8");
    expect(persisted).not.toContain(pnJid);
    expect(persisted).not.toContain(lidJid);
    expect(persisted).not.toContain("15551234567");
    expect(persisted).not.toContain("987654321");
    expect(fs.readdirSync(tempDirectory)).toEqual(["identity-bindings.json"]);

    const reopened = openStore();
    expect(reopened.resolveIdentity({ senderJid: lidJid })).toMatchObject({
      status: "authorized",
      binding: {
        bindingId: authorized.bindingId,
        hasPn: true,
        hasLid: true,
      },
    });
  });

  it("never creates an allowlist entry from an entirely unknown PN/LID pair", async () => {
    const store = openStore();
    const assertion = {
      senderJid: "15550000001@s.whatsapp.net",
      pnJid: "15550000001@s.whatsapp.net",
      lidJid: "111111111@lid",
      bindingEvidence: PROVIDER_EVIDENCE,
    };

    expect(
      store.resolveIdentity(assertion, {
        verifiedBindingEvidence: await verifyEvidence(assertion),
      }),
    ).toEqual({ status: "unknown" });
    expect(store.listBindings()).toEqual([]);
  });

  it("requires supported verified evidence before extending a known identity", async () => {
    const store = openStore();
    const pnJid = "15550000002@s.whatsapp.net";
    const lidJid = "222222222@lid";
    store.authorizeIdentity({ pnJid, evidence: EXPLICIT_EVIDENCE });

    expect(
      store.resolveIdentity({
        senderJid: pnJid,
        pnJid,
        lidJid,
      }),
    ).toEqual({ status: "evidence-required" });
    expect(
      store.resolveIdentity({
        senderJid: pnJid,
        pnJid,
        lidJid,
        bindingEvidence: { source: "provider-pn-lid", version: 2 },
      }),
    ).toEqual({ status: "evidence-unsupported" });
    expect(store.listBindings()[0]).toMatchObject({ hasPn: true, hasLid: false });

    const assertion = {
      senderJid: pnJid,
      pnJid,
      lidJid,
      bindingEvidence: PROVIDER_EVIDENCE,
    };
    expect(store.resolveIdentity(assertion)).toEqual({ status: "evidence-required" });
    expect(
      store.resolveIdentity(assertion, {
        verifiedBindingEvidence: await verifyEvidence(assertion),
      }),
    ).toMatchObject({
      status: "authorized",
      binding: { hasPn: true, hasLid: true },
    });
  });

  it("rejects spoofed assertions and conflicting authorized mappings", () => {
    const store = openStore();
    const firstPn = "15550000003@s.whatsapp.net";
    const otherPn = "15550000004@s.whatsapp.net";
    const conflictingLid = "333333333@lid";
    store.authorizeIdentity({ pnJid: firstPn, evidence: EXPLICIT_EVIDENCE });
    store.authorizeIdentity({ lidJid: conflictingLid, evidence: EXPLICIT_EVIDENCE });

    expect(
      store.resolveIdentity({
        senderJid: firstPn,
        pnJid: otherPn,
      }),
    ).toEqual({ status: "conflict" });
    expect(
      store.resolveIdentity({
        senderJid: firstPn,
        pnJid: firstPn,
        lidJid: conflictingLid,
        bindingEvidence: PROVIDER_EVIDENCE,
      }),
    ).toEqual({ status: "conflict" });
    expect(() =>
      store.authorizeIdentity({
        pnJid: firstPn,
        lidJid: conflictingLid,
        evidence: EXPLICIT_EVIDENCE,
      }),
    ).toThrow(WhatsAppIdentityBindingConflictError);
  });

  it("never overwrites an established alternate identifier", () => {
    const store = openStore();
    const pnJid = "15550000006@s.whatsapp.net";
    const establishedLid = "444444444@lid";
    const replacementLid = "555555555@lid";
    store.authorizeIdentity({
      pnJid,
      lidJid: establishedLid,
      evidence: EXPLICIT_EVIDENCE,
    });

    expect(
      store.resolveIdentity({
        senderJid: pnJid,
        pnJid,
        lidJid: replacementLid,
        bindingEvidence: PROVIDER_EVIDENCE,
      }),
    ).toEqual({ status: "conflict" });
    expect(() =>
      store.authorizeIdentity({
        pnJid,
        lidJid: replacementLid,
        evidence: EXPLICIT_EVIDENCE,
      }),
    ).toThrow(WhatsAppIdentityBindingConflictError);
    expect(store.resolveIdentity({ senderJid: establishedLid })).toMatchObject({
      status: "authorized",
      binding: { hasPn: true, hasLid: true },
    });
    expect(store.resolveIdentity({ senderJid: replacementLid })).toEqual({
      status: "unknown",
    });
  });

  it("rejects a persisted digest store opened with different key material", () => {
    const store = openStore();
    store.authorizeIdentity({
      pnJid: "15550000005@s.whatsapp.net",
      evidence: EXPLICIT_EVIDENCE,
    });
    store.close();

    expect(() =>
      WhatsAppIdentityBindingStore.open({
        filePath,
        keyMaterial: randomBytes(32),
        revisionAnchor,
      }),
    ).toThrow(WhatsAppIdentityBindingStoreWrongKeyError);
  });

  it("reloads concurrent writes instead of resurrecting revoked identities", () => {
    const seed = openStore();
    const pnJid = "15550000007@s.whatsapp.net";
    const otherPnJid = "15550000009@s.whatsapp.net";
    const binding = seed.authorizeIdentity({
      pnJid,
      evidence: EXPLICIT_EVIDENCE,
      authorizedAtMs: 10,
    });
    seed.close();

    const current = openStore();
    const stale = openStore();
    current.revokeIdentity(binding.bindingId, 20);
    stale.authorizeIdentity({
      pnJid: otherPnJid,
      evidence: EXPLICIT_EVIDENCE,
      authorizedAtMs: 30,
    });

    const reopened = openStore();
    expect(reopened.resolveIdentity({ senderJid: pnJid })).toEqual({
      status: "not-authorized",
    });
    expect(reopened.resolveIdentity({ senderJid: otherPnJid })).toMatchObject({
      status: "authorized",
      binding: { hasPn: true, hasLid: false },
    });
  });

  it("rejects backdated mutations without corrupting the persisted store", () => {
    const store = openStore();
    const pnJid = "15550000008@s.whatsapp.net";
    const binding = store.authorizeIdentity({
      pnJid,
      evidence: EXPLICIT_EVIDENCE,
      authorizedAtMs: 20,
    });

    expect(() => store.revokeIdentity(binding.bindingId, 19)).toThrow(
      WhatsAppIdentityBindingStoreConfigurationError,
    );
    store.close();

    const reopened = openStore();
    expect(reopened.resolveIdentity({ senderJid: pnJid })).toMatchObject({
      status: "authorized",
      binding: { bindingVersion: 1 },
    });
  });

  it("rejects rollback to an older authenticated snapshot", () => {
    const store = openStore();
    const pnJid = "15550000010@s.whatsapp.net";
    const binding = store.authorizeIdentity({
      pnJid,
      evidence: EXPLICIT_EVIDENCE,
      authorizedAtMs: 10,
    });
    const authorizedSnapshot = fs.readFileSync(filePath);
    store.revokeIdentity(binding.bindingId, 20);
    fs.writeFileSync(filePath, authorizedSnapshot);

    expect(() => store.resolveIdentity({ senderJid: pnJid })).toThrow(
      WhatsAppIdentityBindingStoreRollbackError,
    );
  });

  it("does not publish a mutation when the revision anchor fails first", () => {
    const store = openStore();
    const pnJid = "15550000011@s.whatsapp.net";
    failAnchorAdvance = true;

    expect(() =>
      store.authorizeIdentity({
        pnJid,
        evidence: EXPLICIT_EVIDENCE,
      }),
    ).toThrow(WhatsAppIdentityBindingStoreIoError);
    failAnchorAdvance = false;
    expect(store.resolveIdentity({ senderJid: pnJid })).toEqual({ status: "unknown" });
  });

  it("fails closed when the anchor outcome is ambiguous", () => {
    const store = openStore();
    const pnJid = "15550000012@s.whatsapp.net";
    failAfterAnchorAdvance = true;

    expect(() =>
      store.authorizeIdentity({
        pnJid,
        evidence: EXPLICIT_EVIDENCE,
      }),
    ).toThrow(WhatsAppIdentityBindingStoreIoError);
    failAfterAnchorAdvance = false;
    expect(() => store.resolveIdentity({ senderJid: pnJid })).toThrow(
      WhatsAppIdentityBindingStoreRollbackError,
    );
  });

  function openStore(): WhatsAppIdentityBindingStore {
    const store = WhatsAppIdentityBindingStore.open({
      filePath,
      keyMaterial,
      revisionAnchor,
    });
    stores.push(store);
    return store;
  }

  async function verifyEvidence(
    assertion: WhatsAppIdentityAssertion,
  ): Promise<VerifiedWhatsAppProviderIdentityBindingEvidence> {
    const receipt = await verifyWhatsAppProviderIdentityBindingEvidence(
      assertion,
      EVIDENCE_SCOPE,
      async () => true,
    );
    if (!receipt) throw new Error("Expected provider identity evidence to verify.");
    return receipt;
  }
});
