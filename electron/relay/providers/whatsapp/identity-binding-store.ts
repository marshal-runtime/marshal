import { createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { secureAtomicWriteFileSync, secureMkdirSync } from "../../../platform-security";

const SCHEMA_VERSION = 1;
const ROOT_KEY_BYTES = 32;
const STORE_SALT_BYTES = 32;
const DERIVED_KEY_BYTES = 32;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_BINDINGS = 2048;
const DIGEST_PREFIX = "hmac-sha256:";
const DIGEST_BYTES = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERIFIED_EVIDENCE = Symbol("verified-whatsapp-identity-binding-evidence");
const verifiedEvidenceReceipts = new WeakSet();

const KEY_CHECK_CONTEXT = Buffer.from(
  "marshal-whatsapp-identity-binding-store:key-check:v1",
  "utf8",
);
const INTEGRITY_CONTEXT = Buffer.from(
  "marshal-whatsapp-identity-binding-store:integrity:v1",
  "utf8",
);
const IDENTITY_DIGEST_CONTEXT = Buffer.from(
  "marshal-whatsapp-identity-binding-store:identity:v1",
  "utf8",
);

const KNOWN_ROOT_FIELDS = new Set([
  "schemaVersion",
  "storeSalt",
  "keyCheck",
  "revision",
  "bindings",
  "integrity",
]);
const KNOWN_BINDING_FIELDS = new Set([
  "bindingId",
  "authorized",
  "pnDigest",
  "lidDigest",
  "bindingVersion",
  "evidenceSource",
  "evidenceVersion",
  "createdAtMs",
  "updatedAtMs",
]);

export const WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION = 1 as const;

export type WhatsAppIdentityEvidenceSource = "explicit-authorization" | "provider-pn-lid";

export interface WhatsAppExplicitIdentityAuthorizationEvidence {
  readonly source: "explicit-authorization";
  readonly version: typeof WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION;
}

export interface WhatsAppProviderIdentityBindingEvidence {
  readonly source: "provider-pn-lid";
  readonly version: typeof WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION;
}

export interface WhatsAppIdentityBindingEvidenceScope {
  readonly providerId: "whatsapp-baileys";
  readonly accountId: string;
  readonly conversationId: string;
  readonly providerMessageId: string;
}

export interface WhatsAppProviderIdentityBindingVerificationRequest {
  readonly pnJid: string;
  readonly lidJid: string;
  readonly evidence: WhatsAppProviderIdentityBindingEvidence;
  readonly scope: WhatsAppIdentityBindingEvidenceScope;
}

export type WhatsAppProviderIdentityBindingEvidenceVerifier = (
  request: WhatsAppProviderIdentityBindingVerificationRequest,
) => boolean | Promise<boolean>;

export interface VerifiedWhatsAppProviderIdentityBindingEvidence {
  readonly pnJid: string;
  readonly lidJid: string;
  readonly evidence: WhatsAppProviderIdentityBindingEvidence;
  readonly [VERIFIED_EVIDENCE]: true;
}

export interface WhatsAppIdentityAssertion {
  readonly senderJid: string;
  readonly pnJid?: string;
  readonly lidJid?: string;
  readonly bindingEvidence?: {
    readonly source: string;
    readonly version: number;
  };
}

export interface AuthorizeWhatsAppIdentityInput {
  readonly pnJid?: string;
  readonly lidJid?: string;
  readonly evidence: WhatsAppExplicitIdentityAuthorizationEvidence;
  readonly authorizedAtMs?: number;
}

export interface ResolveWhatsAppIdentityOptions {
  readonly verifiedBindingEvidence?: VerifiedWhatsAppProviderIdentityBindingEvidence;
  readonly observedAtMs?: number;
}

export interface WhatsAppIdentityBindingMetadata {
  readonly bindingId: string;
  readonly authorized: boolean;
  readonly hasPn: boolean;
  readonly hasLid: boolean;
  readonly bindingVersion: number;
  readonly evidenceSource: WhatsAppIdentityEvidenceSource;
  readonly evidenceVersion: typeof WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type WhatsAppIdentityResolution =
  | {
      readonly status: "authorized";
      readonly binding: WhatsAppIdentityBindingMetadata;
    }
  | {
      readonly status:
        | "unknown"
        | "not-authorized"
        | "conflict"
        | "invalid"
        | "evidence-required"
        | "evidence-unsupported";
    };

export interface OpenWhatsAppIdentityBindingStoreOptions {
  readonly filePath: string;
  readonly keyMaterial: Uint8Array;
  readonly revisionAnchor: WhatsAppIdentityBindingRevisionAnchor;
  readonly now?: () => number;
  readonly createId?: () => string;
}

export interface WhatsAppIdentityBindingRevisionAnchor {
  read(): number | null;
  compareAndAdvance(expectedRevision: number | null, nextRevision: number): boolean;
}

export type WhatsAppIdentityBindingStoreErrorCode =
  | "INVALID_CONFIGURATION"
  | "IO_FAILURE"
  | "WRONG_KEY"
  | "CORRUPT_STORE"
  | "IDENTITY_CONFLICT"
  | "STALE_STORE"
  | "ROLLBACK_DETECTED"
  | "STORE_CAPACITY"
  | "STORE_CLOSED";

export class WhatsAppIdentityBindingStoreError extends Error {
  constructor(
    readonly code: WhatsAppIdentityBindingStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WhatsAppIdentityBindingStoreConfigurationError extends WhatsAppIdentityBindingStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("INVALID_CONFIGURATION", message, options);
  }
}

export class WhatsAppIdentityBindingStoreIoError extends WhatsAppIdentityBindingStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("IO_FAILURE", message, options);
  }
}

export class WhatsAppIdentityBindingStoreWrongKeyError extends WhatsAppIdentityBindingStoreError {
  constructor(options?: ErrorOptions) {
    super(
      "WRONG_KEY",
      "The supplied key material does not match this WhatsApp identity-binding store.",
      options,
    );
  }
}

export class WhatsAppIdentityBindingStoreCorruptionError extends WhatsAppIdentityBindingStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("CORRUPT_STORE", message, options);
  }
}

export class WhatsAppIdentityBindingConflictError extends WhatsAppIdentityBindingStoreError {
  constructor() {
    super(
      "IDENTITY_CONFLICT",
      "The supplied WhatsApp identifiers are already assigned to different identities.",
    );
  }
}

export class WhatsAppIdentityBindingStoreStaleError extends WhatsAppIdentityBindingStoreError {
  constructor(options?: ErrorOptions) {
    super(
      "STALE_STORE",
      "The WhatsApp identity-binding store changed before this write could commit.",
      options,
    );
  }
}

export class WhatsAppIdentityBindingStoreRollbackError extends WhatsAppIdentityBindingStoreError {
  constructor(options?: ErrorOptions) {
    super(
      "ROLLBACK_DETECTED",
      "The WhatsApp identity-binding store revision regressed below its protected anchor.",
      options,
    );
  }
}

export class WhatsAppIdentityBindingStoreCapacityError extends WhatsAppIdentityBindingStoreError {
  constructor() {
    super("STORE_CAPACITY", "The WhatsApp identity-binding store reached its size limit.");
  }
}

export class WhatsAppIdentityBindingStoreClosedError extends WhatsAppIdentityBindingStoreError {
  constructor() {
    super("STORE_CLOSED", "The WhatsApp identity-binding store is closed.");
  }
}

interface StoredBinding {
  readonly bindingId: string;
  readonly authorized: boolean;
  readonly pnDigest?: string;
  readonly lidDigest?: string;
  readonly bindingVersion: number;
  readonly evidenceSource: WhatsAppIdentityEvidenceSource;
  readonly evidenceVersion: typeof WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

interface StoredDocumentCore {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly storeSalt: string;
  readonly keyCheck: string;
  readonly revision: number;
  readonly bindings: readonly StoredBinding[];
}

interface StoredDocument extends StoredDocumentCore {
  readonly integrity: string;
}

interface StoreKeys {
  readonly indexKey: Buffer;
  readonly integrityKey: Buffer;
  readonly checkKey: Buffer;
}

interface ParsedIdentityAssertion {
  readonly pnJid?: string;
  readonly lidJid?: string;
  readonly evidence?: WhatsAppIdentityAssertion["bindingEvidence"];
}

type WhatsAppIdentityKind = "pn" | "lid";

export async function verifyWhatsAppProviderIdentityBindingEvidence(
  assertion: WhatsAppIdentityAssertion,
  scope: WhatsAppIdentityBindingEvidenceScope,
  verifier: WhatsAppProviderIdentityBindingEvidenceVerifier,
): Promise<VerifiedWhatsAppProviderIdentityBindingEvidence | undefined> {
  const parsed = parseIdentityAssertion(assertion);
  const normalizedScope = normalizeEvidenceScope(scope);
  if (
    parsed === "invalid" ||
    parsed === "conflict" ||
    parsed.pnJid === undefined ||
    parsed.lidJid === undefined ||
    validateProviderEvidence(parsed.evidence) !== "valid" ||
    normalizedScope === undefined
  ) {
    return undefined;
  }

  const evidence: WhatsAppProviderIdentityBindingEvidence = {
    source: "provider-pn-lid",
    version: WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION,
  };
  const verified = await verifier({
    pnJid: parsed.pnJid,
    lidJid: parsed.lidJid,
    evidence,
    scope: normalizedScope,
  });
  if (!verified) return undefined;

  const receipt: VerifiedWhatsAppProviderIdentityBindingEvidence = Object.freeze({
    pnJid: parsed.pnJid,
    lidJid: parsed.lidJid,
    evidence,
    [VERIFIED_EVIDENCE]: true as const,
  });
  verifiedEvidenceReceipts.add(receipt);
  return receipt;
}

export class WhatsAppIdentityBindingStore {
  private closed = false;

  private constructor(
    private readonly filePath: string,
    private readonly indexKey: Buffer,
    private readonly integrityKey: Buffer,
    private readonly revisionAnchor: WhatsAppIdentityBindingRevisionAnchor,
    private readonly now: () => number,
    private readonly createId: () => string,
    private document: StoredDocumentCore,
  ) {}

  static open(options: OpenWhatsAppIdentityBindingStoreOptions): WhatsAppIdentityBindingStore {
    const filePath = validateFilePath(options.filePath);
    const rootKey = copyRootKey(options.keyMaterial);
    const revisionAnchor = validateRevisionAnchor(options.revisionAnchor);
    let keys: StoreKeys | undefined;

    try {
      secureMkdirSync(path.dirname(filePath), 0o700);
      rejectSymbolicLink(filePath);

      if (fs.existsSync(filePath)) {
        const stored = readStoredDocument(filePath);
        const salt = decodeFixedDigest(stored.storeSalt, STORE_SALT_BYTES, "store salt");
        keys = deriveKeys(rootKey, salt);
        verifyKeyCheck(stored.keyCheck, keys.checkKey);
        verifyIntegrity(stored, keys.integrityKey);
        requireRevisionAnchor(revisionAnchor, stored.revision);
        keys.checkKey.fill(0);

        return new WhatsAppIdentityBindingStore(
          filePath,
          keys.indexKey,
          keys.integrityKey,
          revisionAnchor,
          options.now ?? Date.now,
          options.createId ?? randomUUID,
          documentCore(stored),
        );
      }

      const salt = randomBytes(STORE_SALT_BYTES);
      if (readRevisionAnchor(revisionAnchor) !== null) {
        throw new WhatsAppIdentityBindingStoreRollbackError();
      }
      keys = deriveKeys(rootKey, salt);
      const document: StoredDocumentCore = {
        schemaVersion: SCHEMA_VERSION,
        storeSalt: salt.toString("base64url"),
        keyCheck: computeKeyCheck(keys.checkKey),
        revision: 0,
        bindings: [],
      };
      keys.checkKey.fill(0);

      const store = new WhatsAppIdentityBindingStore(
        filePath,
        keys.indexKey,
        keys.integrityKey,
        revisionAnchor,
        options.now ?? Date.now,
        options.createId ?? randomUUID,
        document,
      );
      store.persistInitial(document);
      return store;
    } catch (error) {
      zeroKeys(keys);
      if (error instanceof WhatsAppIdentityBindingStoreError) throw error;
      throw new WhatsAppIdentityBindingStoreIoError(
        "Failed to open the WhatsApp identity-binding store.",
        { cause: error },
      );
    } finally {
      rootKey.fill(0);
    }
  }

  authorizeIdentity(input: AuthorizeWhatsAppIdentityInput): WhatsAppIdentityBindingMetadata {
    this.assertOpen();
    this.refreshFromDisk();
    validateExplicitEvidence(input.evidence);
    const pnJid = input.pnJid === undefined ? undefined : normalizePnJid(input.pnJid);
    const lidJid = input.lidJid === undefined ? undefined : normalizeLidJid(input.lidJid);
    if (pnJid === undefined && lidJid === undefined) {
      throw new WhatsAppIdentityBindingStoreConfigurationError(
        "Explicit authorization requires a PN or LID identifier.",
      );
    }

    const pnDigest = pnJid === undefined ? undefined : this.identityDigest("pn", pnJid);
    const lidDigest = lidJid === undefined ? undefined : this.identityDigest("lid", lidJid);
    const pnBinding = pnDigest === undefined ? undefined : this.findByDigest("pn", pnDigest);
    const lidBinding = lidDigest === undefined ? undefined : this.findByDigest("lid", lidDigest);
    if (pnBinding && lidBinding && pnBinding.bindingId !== lidBinding.bindingId) {
      throw new WhatsAppIdentityBindingConflictError();
    }

    const existing = pnBinding ?? lidBinding;
    const now = requireMutationTimestamp(input.authorizedAtMs ?? this.now());
    if (!existing) {
      const binding: StoredBinding = {
        bindingId: validateBindingId(this.createId()),
        authorized: true,
        ...(pnDigest === undefined ? {} : { pnDigest }),
        ...(lidDigest === undefined ? {} : { lidDigest }),
        bindingVersion: 1,
        evidenceSource: input.evidence.source,
        evidenceVersion: input.evidence.version,
        createdAtMs: now,
        updatedAtMs: now,
      };
      return this.commit([...this.document.bindings, binding], binding.bindingId);
    }
    if (
      (pnDigest !== undefined &&
        existing.pnDigest !== undefined &&
        pnDigest !== existing.pnDigest) ||
      (lidDigest !== undefined &&
        existing.lidDigest !== undefined &&
        lidDigest !== existing.lidDigest)
    ) {
      throw new WhatsAppIdentityBindingConflictError();
    }

    const updated: StoredBinding = {
      ...existing,
      authorized: true,
      ...(pnDigest === undefined ? {} : { pnDigest }),
      ...(lidDigest === undefined ? {} : { lidDigest }),
      bindingVersion: existing.bindingVersion + 1,
      evidenceSource: input.evidence.source,
      evidenceVersion: input.evidence.version,
      updatedAtMs: now,
    };
    if (bindingsEqual(existing, updated)) return bindingMetadata(existing);
    requireMonotonicMutationTimestamp(now, existing.updatedAtMs);
    return this.replaceAndCommit(updated);
  }

  revokeIdentity(bindingId: string, revokedAtMs = this.now()): WhatsAppIdentityBindingMetadata {
    this.assertOpen();
    this.refreshFromDisk();
    const normalizedBindingId = validateBindingId(bindingId);
    const existing = this.document.bindings.find(
      (binding) => binding.bindingId === normalizedBindingId,
    );
    if (!existing) {
      throw new WhatsAppIdentityBindingStoreConfigurationError(
        "The identity binding does not exist.",
      );
    }
    if (!existing.authorized) return bindingMetadata(existing);

    const revokedAt = requireMutationTimestamp(revokedAtMs);
    requireMonotonicMutationTimestamp(revokedAt, existing.updatedAtMs);
    return this.replaceAndCommit({
      ...existing,
      authorized: false,
      bindingVersion: existing.bindingVersion + 1,
      updatedAtMs: revokedAt,
    });
  }

  resolveIdentity(
    assertion: WhatsAppIdentityAssertion,
    options: ResolveWhatsAppIdentityOptions = {},
  ): WhatsAppIdentityResolution {
    this.assertOpen();
    this.refreshFromDisk();
    const parsed = parseIdentityAssertion(assertion);
    if (parsed === "invalid") return { status: "invalid" };
    if (parsed === "conflict") return { status: "conflict" };

    const pnDigest =
      parsed.pnJid === undefined ? undefined : this.identityDigest("pn", parsed.pnJid);
    const lidDigest =
      parsed.lidJid === undefined ? undefined : this.identityDigest("lid", parsed.lidJid);
    const pnBinding = pnDigest === undefined ? undefined : this.findByDigest("pn", pnDigest);
    const lidBinding = lidDigest === undefined ? undefined : this.findByDigest("lid", lidDigest);

    if (pnBinding && lidBinding && pnBinding.bindingId !== lidBinding.bindingId) {
      return { status: "conflict" };
    }

    const existing = pnBinding ?? lidBinding;
    if (!existing) return { status: "unknown" };
    if (!existing.authorized) return { status: "not-authorized" };
    if (
      (pnDigest !== undefined &&
        existing.pnDigest !== undefined &&
        pnDigest !== existing.pnDigest) ||
      (lidDigest !== undefined &&
        existing.lidDigest !== undefined &&
        lidDigest !== existing.lidDigest)
    ) {
      return { status: "conflict" };
    }

    const hasUnboundPair =
      (pnDigest !== undefined && pnBinding === undefined) ||
      (lidDigest !== undefined && lidBinding === undefined);
    if (!hasUnboundPair) {
      return { status: "authorized", binding: bindingMetadata(existing) };
    }

    const evidenceStatus = validateProviderEvidence(parsed.evidence);
    if (evidenceStatus !== "valid") {
      return {
        status: evidenceStatus === "missing" ? "evidence-required" : "evidence-unsupported",
      };
    }
    if (!consumeVerifiedEvidence(options.verifiedBindingEvidence, parsed.pnJid, parsed.lidJid)) {
      return { status: "evidence-required" };
    }

    const observedAt = requireMutationTimestamp(options.observedAtMs ?? this.now());
    requireMonotonicMutationTimestamp(observedAt, existing.updatedAtMs);
    const updated: StoredBinding = {
      ...existing,
      ...(pnDigest === undefined ? {} : { pnDigest }),
      ...(lidDigest === undefined ? {} : { lidDigest }),
      bindingVersion: existing.bindingVersion + 1,
      evidenceSource: "provider-pn-lid",
      evidenceVersion: WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION,
      updatedAtMs: observedAt,
    };
    return {
      status: "authorized",
      binding: this.replaceAndCommit(updated),
    };
  }

  listBindings(): readonly WhatsAppIdentityBindingMetadata[] {
    this.assertOpen();
    this.refreshFromDisk();
    return this.document.bindings.map(bindingMetadata);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.indexKey.fill(0);
    this.integrityKey.fill(0);
  }

  private replaceAndCommit(updated: StoredBinding): WhatsAppIdentityBindingMetadata {
    const next = this.document.bindings.map((binding) =>
      binding.bindingId === updated.bindingId ? updated : binding,
    );
    return this.commit(next, updated.bindingId);
  }

  private refreshFromDisk(): void {
    if (!fs.existsSync(this.filePath)) {
      throw new WhatsAppIdentityBindingStoreCorruptionError(
        "The WhatsApp identity-binding store disappeared before a read.",
      );
    }
    const current = readStoredDocument(this.filePath);
    verifyIntegrity(current, this.integrityKey);
    if (current.revision < this.document.revision) {
      throw new WhatsAppIdentityBindingStoreRollbackError();
    }
    requireRevisionAnchor(this.revisionAnchor, current.revision);
    this.document = documentCore(current);
  }

  private commit(
    bindings: readonly StoredBinding[],
    changedBindingId: string,
  ): WhatsAppIdentityBindingMetadata {
    const next: StoredDocumentCore = {
      ...this.document,
      revision: this.document.revision + 1,
      bindings: [...bindings].sort((left, right) => left.bindingId.localeCompare(right.bindingId)),
    };
    validateBindingSet(next.bindings, next.revision);
    this.persist(next);
    this.document = next;
    const changed = next.bindings.find((binding) => binding.bindingId === changedBindingId);
    if (!changed) {
      throw new WhatsAppIdentityBindingStoreCorruptionError(
        "The updated identity binding was not persisted.",
      );
    }
    return bindingMetadata(changed);
  }

  private persistInitial(document: StoredDocumentCore): void {
    if (fs.existsSync(this.filePath)) throw new WhatsAppIdentityBindingStoreStaleError();
    advanceRevisionAnchor(this.revisionAnchor, null, document.revision);
    this.writeDocument(document);
  }

  private persist(document: StoredDocumentCore): void {
    if (!fs.existsSync(this.filePath)) {
      throw new WhatsAppIdentityBindingStoreCorruptionError(
        "The WhatsApp identity-binding store disappeared before a write.",
      );
    }
    const current = readStoredDocument(this.filePath);
    verifyIntegrity(current, this.integrityKey);
    if (serializeCore(documentCore(current)) !== serializeCore(this.document)) {
      throw new WhatsAppIdentityBindingStoreStaleError();
    }
    advanceRevisionAnchor(this.revisionAnchor, this.document.revision, document.revision);
    this.writeDocument(document);
  }

  private writeDocument(document: StoredDocumentCore): void {
    const integrity = computeIntegrity(document, this.integrityKey);
    const serialized = `${serializeDocument({ ...document, integrity })}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) {
      throw new WhatsAppIdentityBindingStoreCapacityError();
    }
    try {
      secureAtomicWriteFileSync(this.filePath, serialized, {
        encoding: "utf8",
        mode: 0o600,
        directoryMode: 0o700,
      });
    } catch (error) {
      try {
        const persisted = readStoredDocument(this.filePath);
        verifyIntegrity(persisted, this.integrityKey);
        if (serializeCore(documentCore(persisted)) === serializeCore(document)) return;
        throw new Error("The persisted identity-binding document does not match the commit.", {
          cause: error,
        });
      } catch (verificationError) {
        throw new WhatsAppIdentityBindingStoreIoError(
          "Failed to persist the WhatsApp identity-binding store.",
          { cause: new AggregateError([error, verificationError]) },
        );
      }
    }
  }

  private findByDigest(kind: WhatsAppIdentityKind, digest: string): StoredBinding | undefined {
    const property = kind === "pn" ? "pnDigest" : "lidDigest";
    return this.document.bindings.find((binding) => binding[property] === digest);
  }

  private identityDigest(kind: WhatsAppIdentityKind, jid: string): string {
    const hmac = createHmac("sha256", this.indexKey);
    hmac.update(IDENTITY_DIGEST_CONTEXT);
    hmac.update(Buffer.from([kind === "pn" ? 1 : 2]));
    const encoded = Buffer.from(jid, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.length);
    hmac.update(length);
    hmac.update(encoded);
    return `${DIGEST_PREFIX}${hmac.digest("base64url")}`;
  }

  private assertOpen(): void {
    if (this.closed) throw new WhatsAppIdentityBindingStoreClosedError();
  }
}

export function openWhatsAppIdentityBindingStore(
  options: OpenWhatsAppIdentityBindingStoreOptions,
): WhatsAppIdentityBindingStore {
  return WhatsAppIdentityBindingStore.open(options);
}

function parseIdentityAssertion(
  assertion: WhatsAppIdentityAssertion,
): ParsedIdentityAssertion | "invalid" | "conflict" {
  if (!isObjectRecord(assertion)) return "invalid";

  const sender = normalizeIdentityJid(assertion.senderJid);
  if (!sender) return "invalid";

  const providedPn = assertion.pnJid === undefined ? undefined : tryNormalizePnJid(assertion.pnJid);
  const providedLid =
    assertion.lidJid === undefined ? undefined : tryNormalizeLidJid(assertion.lidJid);
  if (
    (assertion.pnJid !== undefined && providedPn === undefined) ||
    (assertion.lidJid !== undefined && providedLid === undefined)
  ) {
    return "invalid";
  }

  if (sender.kind === "pn" && providedPn !== undefined && sender.jid !== providedPn) {
    return "conflict";
  }
  if (sender.kind === "lid" && providedLid !== undefined && sender.jid !== providedLid) {
    return "conflict";
  }

  return {
    pnJid: sender.kind === "pn" ? sender.jid : providedPn,
    lidJid: sender.kind === "lid" ? sender.jid : providedLid,
    ...(assertion.bindingEvidence === undefined ? {} : { evidence: assertion.bindingEvidence }),
  };
}

function normalizeIdentityJid(
  value: unknown,
): { readonly kind: WhatsAppIdentityKind; readonly jid: string } | undefined {
  const pnJid = tryNormalizePnJid(value);
  if (pnJid !== undefined) return { kind: "pn", jid: pnJid };
  const lidJid = tryNormalizeLidJid(value);
  return lidJid === undefined ? undefined : { kind: "lid", jid: lidJid };
}

function normalizePnJid(value: unknown): string {
  const normalized = tryNormalizePnJid(value);
  if (normalized === undefined) {
    throw new WhatsAppIdentityBindingStoreConfigurationError(
      "A PN identity must be a canonical WhatsApp PN JID.",
    );
  }
  return normalized;
}

function normalizeLidJid(value: unknown): string {
  const normalized = tryNormalizeLidJid(value);
  if (normalized === undefined) {
    throw new WhatsAppIdentityBindingStoreConfigurationError(
      "A LID identity must be a canonical WhatsApp LID JID.",
    );
  }
  return normalized;
}

function tryNormalizePnJid(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() !== value) return undefined;
  const normalized = value.toLowerCase();
  return /^[0-9]{1,32}@s\.whatsapp\.net$/.test(normalized) ? normalized : undefined;
}

function tryNormalizeLidJid(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() !== value) return undefined;
  const normalized = value.toLowerCase();
  return /^[0-9]{1,32}@lid$/.test(normalized) ? normalized : undefined;
}

function validateProviderEvidence(
  evidence: WhatsAppIdentityAssertion["bindingEvidence"],
): "valid" | "missing" | "unsupported" {
  if (evidence === undefined) return "missing";
  return evidence.source === "provider-pn-lid" &&
    evidence.version === WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION
    ? "valid"
    : "unsupported";
}

function consumeVerifiedEvidence(
  receipt: VerifiedWhatsAppProviderIdentityBindingEvidence | undefined,
  pnJid: string | undefined,
  lidJid: string | undefined,
): boolean {
  const matches =
    receipt !== undefined &&
    verifiedEvidenceReceipts.has(receipt) &&
    receipt[VERIFIED_EVIDENCE] &&
    pnJid !== undefined &&
    lidJid !== undefined &&
    receipt.pnJid === pnJid &&
    receipt.lidJid === lidJid &&
    receipt.evidence.source === "provider-pn-lid" &&
    receipt.evidence.version === WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION;
  if (matches && receipt !== undefined) verifiedEvidenceReceipts.delete(receipt);
  return matches;
}

function normalizeEvidenceScope(
  scope: WhatsAppIdentityBindingEvidenceScope,
): WhatsAppIdentityBindingEvidenceScope | undefined {
  if (!isObjectRecord(scope) || scope.providerId !== "whatsapp-baileys") return undefined;
  const accountId = normalizeScopeValue(scope.accountId);
  const conversationId = normalizeScopeValue(scope.conversationId);
  const providerMessageId = normalizeScopeValue(scope.providerMessageId);
  if (accountId === undefined || conversationId === undefined || providerMessageId === undefined) {
    return undefined;
  }
  return {
    providerId: "whatsapp-baileys",
    accountId,
    conversationId,
    providerMessageId,
  };
}

function normalizeScopeValue(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > 1024
  ) {
    return undefined;
  }
  return value;
}

function validateExplicitEvidence(evidence: WhatsAppExplicitIdentityAuthorizationEvidence): void {
  if (
    !isObjectRecord(evidence) ||
    evidence.source !== "explicit-authorization" ||
    evidence.version !== WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION
  ) {
    throw new WhatsAppIdentityBindingStoreConfigurationError(
      "Explicit identity authorization evidence is invalid.",
    );
  }
}

function validateFilePath(filePath: string): string {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new WhatsAppIdentityBindingStoreConfigurationError(
      "The identity-binding store path is required.",
    );
  }
  if (!path.isAbsolute(filePath)) {
    throw new WhatsAppIdentityBindingStoreConfigurationError(
      "The identity-binding store path must be absolute.",
    );
  }
  return path.resolve(filePath);
}

function validateRevisionAnchor(value: unknown): WhatsAppIdentityBindingRevisionAnchor {
  if (!isRevisionAnchor(value)) {
    throw new WhatsAppIdentityBindingStoreConfigurationError(
      "A protected identity-binding revision anchor is required.",
    );
  }
  return value;
}

function isRevisionAnchor(value: unknown): value is WhatsAppIdentityBindingRevisionAnchor {
  return (
    isObjectRecord(value) &&
    typeof value.read === "function" &&
    typeof value.compareAndAdvance === "function"
  );
}

function requireRevisionAnchor(
  anchor: WhatsAppIdentityBindingRevisionAnchor,
  revision: number,
): void {
  const protectedRevision = readRevisionAnchor(anchor);
  if (protectedRevision !== revision) throw new WhatsAppIdentityBindingStoreRollbackError();
}

function readRevisionAnchor(anchor: WhatsAppIdentityBindingRevisionAnchor): number | null {
  let revision: unknown;
  try {
    revision = anchor.read();
  } catch (error) {
    throw new WhatsAppIdentityBindingStoreIoError(
      "Failed to read the protected identity-binding revision anchor.",
      { cause: error },
    );
  }
  if (revision === null) return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new WhatsAppIdentityBindingStoreIoError(
      "The protected identity-binding revision anchor is invalid.",
    );
  }
  return revision;
}

function advanceRevisionAnchor(
  anchor: WhatsAppIdentityBindingRevisionAnchor,
  expectedRevision: number | null,
  nextRevision: number,
): void {
  if (
    (expectedRevision === null && nextRevision !== 0) ||
    (expectedRevision !== null && nextRevision !== expectedRevision + 1)
  ) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "The identity-binding revision transition is invalid.",
    );
  }

  let advanced: unknown;
  try {
    advanced = anchor.compareAndAdvance(expectedRevision, nextRevision);
  } catch (error) {
    throw new WhatsAppIdentityBindingStoreIoError(
      "Failed to advance the protected identity-binding revision anchor.",
      { cause: error },
    );
  }
  if (advanced !== true) throw new WhatsAppIdentityBindingStoreStaleError();
  if (readRevisionAnchor(anchor) !== nextRevision)
    throw new WhatsAppIdentityBindingStoreRollbackError();
}

function copyRootKey(keyMaterial: Uint8Array): Buffer {
  if (!(keyMaterial instanceof Uint8Array) || keyMaterial.byteLength !== ROOT_KEY_BYTES) {
    throw new WhatsAppIdentityBindingStoreConfigurationError(
      `Identity-binding key material must be exactly ${ROOT_KEY_BYTES} bytes.`,
    );
  }
  return Buffer.from(keyMaterial);
}

function rejectSymbolicLink(filePath: string): void {
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new WhatsAppIdentityBindingStoreConfigurationError(
      "The identity-binding store path must not be a symbolic link.",
    );
  }
}

function deriveKeys(rootKey: Buffer, salt: Buffer): StoreKeys {
  return {
    indexKey: deriveKey(rootKey, salt, "identity-index"),
    integrityKey: deriveKey(rootKey, salt, "integrity"),
    checkKey: deriveKey(rootKey, salt, "key-check"),
  };
}

function deriveKey(rootKey: Buffer, salt: Buffer, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      rootKey,
      salt,
      Buffer.from(`marshal-whatsapp-identity-binding-store:${purpose}:v1`, "utf8"),
      DERIVED_KEY_BYTES,
    ),
  );
}

function computeKeyCheck(checkKey: Buffer): string {
  return createHmac("sha256", checkKey).update(KEY_CHECK_CONTEXT).digest("base64url");
}

function verifyKeyCheck(stored: string, checkKey: Buffer): void {
  const actual = decodeFixedDigest(stored, DIGEST_BYTES, "key check");
  const expected = Buffer.from(computeKeyCheck(checkKey), "base64url");
  if (!timingSafeEqual(actual, expected)) throw new WhatsAppIdentityBindingStoreWrongKeyError();
}

function computeIntegrity(document: StoredDocumentCore, integrityKey: Buffer): string {
  return createHmac("sha256", integrityKey)
    .update(INTEGRITY_CONTEXT)
    .update(serializeCore(document), "utf8")
    .digest("base64url");
}

function verifyIntegrity(document: StoredDocument, integrityKey: Buffer): void {
  const actual = decodeFixedDigest(document.integrity, DIGEST_BYTES, "integrity digest");
  const expected = Buffer.from(computeIntegrity(documentCore(document), integrityKey), "base64url");
  if (!timingSafeEqual(actual, expected)) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "The WhatsApp identity-binding store failed integrity verification.",
    );
  }
}

function readStoredDocument(filePath: string): StoredDocument {
  let content: string;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_STORE_BYTES) {
      throw new WhatsAppIdentityBindingStoreCorruptionError(
        "The WhatsApp identity-binding store has an invalid size.",
      );
    }
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof WhatsAppIdentityBindingStoreError) throw error;
    throw new WhatsAppIdentityBindingStoreIoError(
      "Failed to read the WhatsApp identity-binding store.",
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "The WhatsApp identity-binding store is not valid JSON.",
      { cause: error },
    );
  }
  return parseStoredDocument(parsed);
}

function parseStoredDocument(value: unknown): StoredDocument {
  const root = requireObject(value, "identity-binding store");
  requireKnownFields(root, KNOWN_ROOT_FIELDS, "identity-binding store");
  if (root.schemaVersion !== SCHEMA_VERSION) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "The WhatsApp identity-binding store schema version is unsupported.",
    );
  }

  const storeSalt = requireBase64url(root.storeSalt, "store salt");
  decodeFixedDigest(storeSalt, STORE_SALT_BYTES, "store salt");
  const keyCheck = requireBase64url(root.keyCheck, "key check");
  decodeFixedDigest(keyCheck, DIGEST_BYTES, "key check");
  const revision = requireNonNegativeInteger(root.revision, "store revision");
  if (!Array.isArray(root.bindings) || root.bindings.length > MAX_BINDINGS) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "The WhatsApp identity-binding set is invalid.",
    );
  }
  const bindings = root.bindings.map(parseStoredBinding);
  validateBindingSet(bindings, revision);
  const integrity = requireBase64url(root.integrity, "integrity digest");
  decodeFixedDigest(integrity, DIGEST_BYTES, "integrity digest");

  return {
    schemaVersion: SCHEMA_VERSION,
    storeSalt,
    keyCheck,
    revision,
    bindings,
    integrity,
  };
}

function parseStoredBinding(value: unknown): StoredBinding {
  const binding = requireObject(value, "identity binding");
  requireKnownFields(binding, KNOWN_BINDING_FIELDS, "identity binding");
  const bindingId = validateBindingId(binding.bindingId);
  if (typeof binding.authorized !== "boolean") {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "An identity binding authorization flag is invalid.",
    );
  }
  const pnDigest =
    binding.pnDigest === undefined ? undefined : requireIdentityDigest(binding.pnDigest);
  const lidDigest =
    binding.lidDigest === undefined ? undefined : requireIdentityDigest(binding.lidDigest);
  if (pnDigest === undefined && lidDigest === undefined) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "An identity binding has no identifiers.",
    );
  }

  const evidenceSource = requireEvidenceSource(binding.evidenceSource);
  if (binding.evidenceVersion !== WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "An identity binding evidence version is unsupported.",
    );
  }
  const bindingVersion = requirePositiveInteger(binding.bindingVersion, "binding version");
  const createdAtMs = requireTimestamp(binding.createdAtMs);
  const updatedAtMs = requireTimestamp(binding.updatedAtMs);
  if (updatedAtMs < createdAtMs) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "An identity binding timestamp range is invalid.",
    );
  }

  return {
    bindingId,
    authorized: binding.authorized,
    ...(pnDigest === undefined ? {} : { pnDigest }),
    ...(lidDigest === undefined ? {} : { lidDigest }),
    bindingVersion,
    evidenceSource,
    evidenceVersion: WHATSAPP_IDENTITY_BINDING_EVIDENCE_VERSION,
    createdAtMs,
    updatedAtMs,
  };
}

function validateBindingSet(bindings: readonly StoredBinding[], revision: number): void {
  if (bindings.length > MAX_BINDINGS) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "The WhatsApp identity-binding store exceeds its binding limit.",
    );
  }

  const bindingIds = new Set<string>();
  const pnDigests = new Set<string>();
  const lidDigests = new Set<string>();
  let priorBindingId: string | undefined;
  for (const binding of bindings) {
    if (priorBindingId !== undefined && priorBindingId.localeCompare(binding.bindingId) >= 0) {
      throw new WhatsAppIdentityBindingStoreCorruptionError(
        "The WhatsApp identity-binding set is not canonically ordered.",
      );
    }
    priorBindingId = binding.bindingId;
    if (bindingIds.has(binding.bindingId)) {
      throw new WhatsAppIdentityBindingStoreCorruptionError(
        "The WhatsApp identity-binding set contains a duplicate binding.",
      );
    }
    bindingIds.add(binding.bindingId);
    if (binding.updatedAtMs < binding.createdAtMs) {
      throw new WhatsAppIdentityBindingStoreCorruptionError(
        "An identity binding timestamp range is invalid.",
      );
    }

    if (binding.pnDigest !== undefined) {
      if (pnDigests.has(binding.pnDigest)) {
        throw new WhatsAppIdentityBindingStoreCorruptionError(
          "The WhatsApp identity-binding set contains a duplicate PN digest.",
        );
      }
      pnDigests.add(binding.pnDigest);
    }
    if (binding.lidDigest !== undefined) {
      if (lidDigests.has(binding.lidDigest)) {
        throw new WhatsAppIdentityBindingStoreCorruptionError(
          "The WhatsApp identity-binding set contains a duplicate LID digest.",
        );
      }
      lidDigests.add(binding.lidDigest);
    }
  }
  if (revision < bindings.length) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "The WhatsApp identity-binding store revision is invalid.",
    );
  }
}

function documentCore(document: StoredDocument): StoredDocumentCore {
  return {
    schemaVersion: document.schemaVersion,
    storeSalt: document.storeSalt,
    keyCheck: document.keyCheck,
    revision: document.revision,
    bindings: document.bindings,
  };
}

function serializeDocument(document: StoredDocument): string {
  return JSON.stringify({
    schemaVersion: document.schemaVersion,
    storeSalt: document.storeSalt,
    keyCheck: document.keyCheck,
    revision: document.revision,
    bindings: document.bindings.map(serializeBinding),
    integrity: document.integrity,
  });
}

function serializeCore(document: StoredDocumentCore): string {
  return JSON.stringify({
    schemaVersion: document.schemaVersion,
    storeSalt: document.storeSalt,
    keyCheck: document.keyCheck,
    revision: document.revision,
    bindings: document.bindings.map(serializeBinding),
  });
}

function serializeBinding(binding: StoredBinding): StoredBinding {
  return {
    bindingId: binding.bindingId,
    authorized: binding.authorized,
    ...(binding.pnDigest === undefined ? {} : { pnDigest: binding.pnDigest }),
    ...(binding.lidDigest === undefined ? {} : { lidDigest: binding.lidDigest }),
    bindingVersion: binding.bindingVersion,
    evidenceSource: binding.evidenceSource,
    evidenceVersion: binding.evidenceVersion,
    createdAtMs: binding.createdAtMs,
    updatedAtMs: binding.updatedAtMs,
  };
}

function bindingMetadata(binding: StoredBinding): WhatsAppIdentityBindingMetadata {
  return {
    bindingId: binding.bindingId,
    authorized: binding.authorized,
    hasPn: binding.pnDigest !== undefined,
    hasLid: binding.lidDigest !== undefined,
    bindingVersion: binding.bindingVersion,
    evidenceSource: binding.evidenceSource,
    evidenceVersion: binding.evidenceVersion,
    createdAtMs: binding.createdAtMs,
    updatedAtMs: binding.updatedAtMs,
  };
}

function bindingsEqual(left: StoredBinding, right: StoredBinding): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.authorized === right.authorized &&
    left.pnDigest === right.pnDigest &&
    left.lidDigest === right.lidDigest &&
    left.evidenceSource === right.evidenceSource &&
    left.evidenceVersion === right.evidenceVersion
  );
}

function validateBindingId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "An identity binding identifier is invalid.",
    );
  }
  return value;
}

function requireEvidenceSource(value: unknown): WhatsAppIdentityEvidenceSource {
  if (value !== "explicit-authorization" && value !== "provider-pn-lid") {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      "An identity binding evidence source is invalid.",
    );
  }
  return value;
}

function requireIdentityDigest(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(DIGEST_PREFIX)) {
    throw new WhatsAppIdentityBindingStoreCorruptionError("An identity digest is invalid.");
  }
  decodeFixedDigest(value.slice(DIGEST_PREFIX.length), DIGEST_BYTES, "identity digest");
  return value;
}

function decodeFixedDigest(value: string, bytes: number, label: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch (error) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(`The ${label} encoding is invalid.`, {
      cause: error,
    });
  }
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(`The ${label} value is invalid.`);
  }
  return decoded;
}

function requireBase64url(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(`The ${label} is invalid.`);
  }
  return value;
}

function requireTimestamp(value: unknown): number {
  return requireNonNegativeInteger(value, "identity binding timestamp");
}

function requireMutationTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WhatsAppIdentityBindingStoreConfigurationError(
      "An identity-binding mutation timestamp is invalid.",
    );
  }
  return value;
}

function requireMonotonicMutationTimestamp(value: number, previous: number): void {
  if (value < previous) {
    throw new WhatsAppIdentityBindingStoreConfigurationError(
      "Identity-binding mutation timestamps must be monotonic.",
    );
  }
}

function requirePositiveInteger(value: unknown, label: string): number {
  const integer = requireNonNegativeInteger(value, label);
  if (integer === 0) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(`The ${label} is invalid.`);
  }
  return integer;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(`The ${label} is invalid.`);
  }
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObjectRecord(value)) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(`The ${label} is invalid.`);
  }
  return value;
}

function requireKnownFields(
  value: Readonly<Record<string, unknown>>,
  knownFields: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(value).some((field) => !knownFields.has(field))) {
    throw new WhatsAppIdentityBindingStoreCorruptionError(
      `The ${label} contains an unknown field.`,
    );
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zeroKeys(keys: StoreKeys | undefined): void {
  keys?.indexKey.fill(0);
  keys?.integrityKey.fill(0);
  keys?.checkKey.fill(0);
}
