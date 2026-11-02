import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { deserialize, serialize } from "node:v8";

import { secureMkdirSync } from "../../../platform-security";

const APPLICATION_ID = 0x4d574153;
const SCHEMA_VERSION = 1;
const ROOT_KEY_BYTES = 32;
const STORE_SALT_BYTES = 32;
const DERIVED_KEY_BYTES = 32;
const RECORD_ID_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENVELOPE_MAGIC = Buffer.from("MWAE", "ascii");
const ENVELOPE_VERSION = 1;
const ENVELOPE_HEADER_BYTES = ENVELOPE_MAGIC.length + 1 + NONCE_BYTES + AUTH_TAG_BYTES;
const MAX_IDENTIFIER_BYTES = 4096;

const METADATA_TABLE = "auth_store_metadata";
const RECORDS_TABLE = "auth_store_records";
const METADATA_NAMES = ["key_check", "metadata_digest", "store_salt", "verifier"] as const;

const KEY_CHECK_CONTEXT = Buffer.from("marshal-whatsapp-auth-store:key-check:v1", "utf8");
const METADATA_DIGEST_CONTEXT = Buffer.from(
  "marshal-whatsapp-auth-store:metadata-digest:v1",
  "utf8",
);
const ENVELOPE_AAD_CONTEXT = Buffer.from("marshal-whatsapp-auth-store:envelope:v1", "utf8");
const VERIFIER_PLAINTEXT = Buffer.from("marshal-whatsapp-auth-store:verified:v1", "utf8");

const CREATE_SCHEMA_SQL = `
  CREATE TABLE ${METADATA_TABLE} (
    name TEXT PRIMARY KEY,
    value BLOB NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE ${RECORDS_TABLE} (
    record_id BLOB PRIMARY KEY CHECK(length(record_id) = ${RECORD_ID_BYTES}),
    envelope BLOB NOT NULL CHECK(length(envelope) >= ${ENVELOPE_HEADER_BYTES})
  ) STRICT, WITHOUT ROWID;
`;

const UPSERT_RECORD_SQL = `
  INSERT INTO ${RECORDS_TABLE} (record_id, envelope)
  VALUES (?, ?)
  ON CONFLICT(record_id) DO UPDATE SET envelope = excluded.envelope
`;

export type WhatsAppAuthStoreErrorCode =
  | "INVALID_CONFIGURATION"
  | "SQLITE_UNAVAILABLE"
  | "IO_FAILURE"
  | "SCHEMA_MISMATCH"
  | "WRONG_KEY"
  | "CORRUPT_STORE"
  | "TRANSACTION_FAILED"
  | "STORE_CLOSED";

export class WhatsAppAuthStoreError extends Error {
  constructor(
    readonly code: WhatsAppAuthStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WhatsAppAuthStoreConfigurationError extends WhatsAppAuthStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("INVALID_CONFIGURATION", message, options);
  }
}

export class WhatsAppAuthStoreUnavailableError extends WhatsAppAuthStoreError {
  constructor(options?: ErrorOptions) {
    super(
      "SQLITE_UNAVAILABLE",
      "The current runtime does not provide the node:sqlite built-in.",
      options,
    );
  }
}

export class WhatsAppAuthStoreIoError extends WhatsAppAuthStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("IO_FAILURE", message, options);
  }
}

export class WhatsAppAuthStoreSchemaError extends WhatsAppAuthStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("SCHEMA_MISMATCH", message, options);
  }
}

export class WhatsAppAuthStoreWrongKeyError extends WhatsAppAuthStoreError {
  constructor(options?: ErrorOptions) {
    super(
      "WRONG_KEY",
      "The supplied key material does not match this WhatsApp auth store.",
      options,
    );
  }
}

export class WhatsAppAuthStoreCorruptionError extends WhatsAppAuthStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("CORRUPT_STORE", message, options);
  }
}

export class WhatsAppAuthStoreTransactionError extends WhatsAppAuthStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("TRANSACTION_FAILED", message, options);
  }
}

export class WhatsAppAuthStoreClosedError extends WhatsAppAuthStoreError {
  constructor() {
    super("STORE_CLOSED", "The WhatsApp auth store is closed.");
  }
}

export type WhatsAppAuthStoreValue = object | string | number | boolean | bigint;

export type WhatsAppSignalKeyUpdates = Readonly<
  Record<string, Readonly<Record<string, WhatsAppAuthStoreValue | null>>>
>;

export interface WhatsAppAuthStoreUpdate {
  credentials?: WhatsAppAuthStoreValue | null;
  signalKeys?: WhatsAppSignalKeyUpdates;
}

export interface OpenWhatsAppAuthStoreOptions {
  databasePath: string;
  keyMaterial: Uint8Array;
}

interface StoreKeys {
  encryptionKey: Buffer;
  indexKey: Buffer;
}

interface DerivedKeys extends StoreKeys {
  checkKey: Buffer;
}

interface SignalKeyMutation {
  category: string;
  id: string;
  value: WhatsAppAuthStoreValue | null;
}

type DatabaseSync = import("node:sqlite").DatabaseSync;

/**
 * Stage 0 only: the parent owns the OS-backed root key and must choose a local,
 * non-synced storage path. This module never persists key material or plaintext.
 */
export class EncryptedWhatsAppAuthStore {
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly encryptionKey: Buffer,
    private readonly indexKey: Buffer,
  ) {}

  static open(options: OpenWhatsAppAuthStoreOptions): EncryptedWhatsAppAuthStore {
    const databasePath = validateDatabasePath(options.databasePath);
    const rootKey = copyRootKey(options.keyMaterial);
    let database: DatabaseSync | undefined;
    let storeKeys: StoreKeys | undefined;

    try {
      const sqlite = process.getBuiltinModule("node:sqlite") as
        | typeof import("node:sqlite")
        | undefined;
      if (!sqlite) throw new WhatsAppAuthStoreUnavailableError();

      secureMkdirSync(path.dirname(databasePath), 0o700);
      rejectSymbolicLink(databasePath);

      database = new sqlite.DatabaseSync(databasePath, {
        enableForeignKeyConstraints: true,
        timeout: 5000,
      });
      fs.chmodSync(databasePath, 0o600);
      verifySqliteIntegrity(database);
      configureDatabase(database);
      storeKeys = bootstrapDatabase(database, rootKey);

      return new EncryptedWhatsAppAuthStore(database, storeKeys.encryptionKey, storeKeys.indexKey);
    } catch (error) {
      zeroStoreKeys(storeKeys);
      const closeError = closeAfterFailedOpen(database);
      if (closeError !== undefined) {
        throw new WhatsAppAuthStoreIoError("Failed to close the WhatsApp auth store.", {
          cause: new AggregateError([error, closeError]),
        });
      }
      if (error instanceof WhatsAppAuthStoreError) throw error;
      throw new WhatsAppAuthStoreIoError("Failed to open the WhatsApp auth store.", {
        cause: error,
      });
    } finally {
      rootKey.fill(0);
    }
  }

  readCredentials(): WhatsAppAuthStoreValue | null {
    this.assertOpen();
    return this.readRecord(credentialsRecordId(this.indexKey));
  }

  readSignalKeys(category: string, ids: readonly string[]): Record<string, WhatsAppAuthStoreValue> {
    this.assertOpen();
    validateIdentifier(category, "Signal-key category");

    const found: Array<[string, WhatsAppAuthStoreValue]> = [];
    for (const id of ids) {
      validateIdentifier(id, "Signal-key identifier");
      const value = this.readRecord(signalKeyRecordId(this.indexKey, category, id));
      if (value !== null) found.push([id, value]);
    }
    return Object.fromEntries(found);
  }

  applyTransaction(update: WhatsAppAuthStoreUpdate): void {
    this.assertOpen();
    const candidate: unknown = update;
    if (!isObjectRecord(candidate)) {
      throw new WhatsAppAuthStoreConfigurationError(
        "A WhatsApp auth-store update must be an object.",
      );
    }
    const hasCredentials = Object.hasOwn(update, "credentials");
    if (hasCredentials && update.credentials === undefined) {
      throw new WhatsAppAuthStoreConfigurationError(
        "A credentials update must contain a value or null.",
      );
    }
    const signalKeyMutations = normalizeSignalKeyUpdates(update.signalKeys);
    if (!hasCredentials && signalKeyMutations.length === 0) return;

    this.runWriteTransaction(() => {
      if (hasCredentials) {
        this.writeRecord(credentialsRecordId(this.indexKey), update.credentials ?? null);
      }
      for (const mutation of signalKeyMutations) {
        this.writeRecord(
          signalKeyRecordId(this.indexKey, mutation.category, mutation.id),
          mutation.value,
        );
      }
    });
  }

  resetAfterTerminalDisconnect(): void {
    this.assertOpen();
    this.runWriteTransaction(() => {
      this.database.exec(`DELETE FROM ${RECORDS_TABLE}`);
    });
  }

  verifyIntegrity(): void {
    this.assertOpen();
    verifySqliteIntegrity(this.database);
    verifyAllRecords(this.database, this.encryptionKey);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } catch (error) {
      throw new WhatsAppAuthStoreIoError("Failed to close the WhatsApp auth store.", {
        cause: error,
      });
    } finally {
      this.encryptionKey.fill(0);
      this.indexKey.fill(0);
    }
  }

  private readRecord(recordId: Buffer): WhatsAppAuthStoreValue | null {
    let row: unknown;
    try {
      row = this.database
        .prepare(`SELECT envelope FROM ${RECORDS_TABLE} WHERE record_id = ?`)
        .get(recordId);
    } catch (error) {
      throw new WhatsAppAuthStoreIoError("Failed to read from the WhatsApp auth store.", {
        cause: error,
      });
    }
    if (row === undefined) return null;
    return decodeStoredValue(readBlobProperty(row, "envelope"), recordId, this.encryptionKey);
  }

  private writeRecord(recordId: Buffer, value: WhatsAppAuthStoreValue | null): void {
    if (value === null) {
      this.database.prepare(`DELETE FROM ${RECORDS_TABLE} WHERE record_id = ?`).run(recordId);
      return;
    }

    const serialized = serialize(value);
    try {
      const envelope = encryptEnvelope(serialized, recordId, this.encryptionKey);
      this.database.prepare(UPSERT_RECORD_SQL).run(recordId, envelope);
    } finally {
      serialized.fill(0);
    }
  }

  private runWriteTransaction(operation: () => void): void {
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw new WhatsAppAuthStoreTransactionError(
        "Failed to begin a WhatsApp auth-store transaction.",
        { cause: error },
      );
    }

    try {
      operation();
      this.database.exec("COMMIT");
    } catch (error) {
      const rollbackError = rollback(this.database);
      if (rollbackError !== undefined) {
        throw new WhatsAppAuthStoreTransactionError(
          "The WhatsApp auth-store transaction failed and could not be rolled back.",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
      throw new WhatsAppAuthStoreTransactionError(
        "The WhatsApp auth-store transaction was rolled back.",
        { cause: error },
      );
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new WhatsAppAuthStoreClosedError();
  }
}

export function openEncryptedWhatsAppAuthStore(
  options: OpenWhatsAppAuthStoreOptions,
): EncryptedWhatsAppAuthStore {
  return EncryptedWhatsAppAuthStore.open(options);
}

function validateDatabasePath(databasePath: string): string {
  if (typeof databasePath !== "string" || databasePath.trim().length === 0) {
    throw new WhatsAppAuthStoreConfigurationError(
      "The WhatsApp auth-store database path is required.",
    );
  }
  if (!path.isAbsolute(databasePath)) {
    throw new WhatsAppAuthStoreConfigurationError(
      "The WhatsApp auth-store database path must be absolute.",
    );
  }
  return path.resolve(databasePath);
}

function copyRootKey(keyMaterial: Uint8Array): Buffer {
  if (!(keyMaterial instanceof Uint8Array) || keyMaterial.byteLength !== ROOT_KEY_BYTES) {
    throw new WhatsAppAuthStoreConfigurationError(
      `WhatsApp auth-store key material must be exactly ${ROOT_KEY_BYTES} bytes.`,
    );
  }
  return Buffer.from(keyMaterial);
}

function rejectSymbolicLink(databasePath: string): void {
  if (fs.existsSync(databasePath) && fs.lstatSync(databasePath).isSymbolicLink()) {
    throw new WhatsAppAuthStoreConfigurationError(
      "The WhatsApp auth-store database path must not be a symbolic link.",
    );
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA temp_store = MEMORY;
    PRAGMA secure_delete = ON;
    PRAGMA trusted_schema = OFF;
  `);
}

function verifySqliteIntegrity(database: DatabaseSync): void {
  let rows: unknown[];
  try {
    rows = database.prepare("PRAGMA integrity_check").all();
  } catch (error) {
    throw new WhatsAppAuthStoreCorruptionError(
      "The WhatsApp auth-store database failed SQLite integrity checking.",
      { cause: error },
    );
  }

  if (
    rows.length !== 1 ||
    readStringProperty(rows[0], "integrity_check", "SQLite integrity result") !== "ok"
  ) {
    throw new WhatsAppAuthStoreCorruptionError(
      "The WhatsApp auth-store database failed SQLite integrity checking.",
    );
  }
}

function bootstrapDatabase(database: DatabaseSync, rootKey: Buffer): StoreKeys {
  database.exec("BEGIN IMMEDIATE");
  let storeKeys: StoreKeys | undefined;

  try {
    const applicationId = readPragmaInteger(database, "application_id");
    const schemaVersion = readPragmaInteger(database, "user_version");
    const tableNames = readUserTableNames(database);

    if (applicationId === 0 && schemaVersion === 0 && tableNames.length === 0) {
      storeKeys = initializeDatabase(database, rootKey);
    } else {
      validateSchema(database, applicationId, schemaVersion, tableNames);
      storeKeys = unlockDatabase(database, rootKey);
    }

    database.exec("COMMIT");
    return storeKeys;
  } catch (error) {
    zeroStoreKeys(storeKeys);
    const rollbackError = rollback(database);
    if (rollbackError !== undefined) {
      throw new WhatsAppAuthStoreIoError(
        "Failed to roll back WhatsApp auth-store initialization.",
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    throw error;
  }
}

function initializeDatabase(database: DatabaseSync, rootKey: Buffer): StoreKeys {
  database.exec(CREATE_SCHEMA_SQL);
  database.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const salt = randomBytes(STORE_SALT_BYTES);
  const keys = deriveKeys(rootKey, salt);
  let success = false;

  try {
    const keyCheck = computeKeyCheck(keys.checkKey);
    const metadataDigest = computeMetadataDigest(salt, keyCheck);
    const verifierId = verifierRecordId(keys.indexKey);
    const verifier = encryptEnvelope(VERIFIER_PLAINTEXT, verifierId, keys.encryptionKey);
    const insert = database.prepare(`INSERT INTO ${METADATA_TABLE} (name, value) VALUES (?, ?)`);

    insert.run("store_salt", salt);
    insert.run("key_check", keyCheck);
    insert.run("metadata_digest", metadataDigest);
    insert.run("verifier", verifier);

    success = true;
    return {
      encryptionKey: keys.encryptionKey,
      indexKey: keys.indexKey,
    };
  } finally {
    keys.checkKey.fill(0);
    if (!success) {
      keys.encryptionKey.fill(0);
      keys.indexKey.fill(0);
    }
  }
}

function unlockDatabase(database: DatabaseSync, rootKey: Buffer): StoreKeys {
  const metadata = readMetadata(database);
  const salt = requireMetadata(metadata, "store_salt", STORE_SALT_BYTES);
  const storedKeyCheck = requireMetadata(metadata, "key_check", DERIVED_KEY_BYTES);
  const storedMetadataDigest = requireMetadata(metadata, "metadata_digest", DERIVED_KEY_BYTES);
  const verifier = requireMetadata(metadata, "verifier");
  const expectedMetadataDigest = computeMetadataDigest(salt, storedKeyCheck);

  if (!timingSafeEqual(storedMetadataDigest, expectedMetadataDigest)) {
    throw new WhatsAppAuthStoreCorruptionError("The WhatsApp auth-store key metadata is corrupt.");
  }

  const keys = deriveKeys(rootKey, salt);
  let success = false;
  try {
    const expectedKeyCheck = computeKeyCheck(keys.checkKey);
    if (!timingSafeEqual(storedKeyCheck, expectedKeyCheck)) {
      throw new WhatsAppAuthStoreWrongKeyError();
    }

    const verifierPlaintext = decryptEnvelope(
      verifier,
      verifierRecordId(keys.indexKey),
      keys.encryptionKey,
    );
    try {
      if (
        verifierPlaintext.length !== VERIFIER_PLAINTEXT.length ||
        !timingSafeEqual(verifierPlaintext, VERIFIER_PLAINTEXT)
      ) {
        throw new WhatsAppAuthStoreCorruptionError("The WhatsApp auth-store verifier is corrupt.");
      }
    } finally {
      verifierPlaintext.fill(0);
    }

    verifyAllRecords(database, keys.encryptionKey);
    success = true;
    return {
      encryptionKey: keys.encryptionKey,
      indexKey: keys.indexKey,
    };
  } finally {
    keys.checkKey.fill(0);
    if (!success) {
      keys.encryptionKey.fill(0);
      keys.indexKey.fill(0);
    }
  }
}

function validateSchema(
  database: DatabaseSync,
  applicationId: number,
  schemaVersion: number,
  tableNames: readonly string[],
): void {
  if (applicationId !== APPLICATION_ID) {
    throw new WhatsAppAuthStoreSchemaError("The database is not a WhatsApp auth-store database.");
  }
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new WhatsAppAuthStoreSchemaError(
      `Unsupported WhatsApp auth-store schema version: ${schemaVersion}.`,
    );
  }
  if (
    tableNames.length !== 2 ||
    tableNames[0] !== METADATA_TABLE ||
    tableNames[1] !== RECORDS_TABLE
  ) {
    throw new WhatsAppAuthStoreSchemaError(
      "The WhatsApp auth-store database has an unexpected table layout.",
    );
  }

  validateTableColumns(database, METADATA_TABLE, [
    { name: "name", type: "TEXT", notNull: true, primaryKey: true },
    { name: "value", type: "BLOB", notNull: true, primaryKey: false },
  ]);
  validateTableColumns(database, RECORDS_TABLE, [
    { name: "record_id", type: "BLOB", notNull: true, primaryKey: true },
    { name: "envelope", type: "BLOB", notNull: true, primaryKey: false },
  ]);
}

function validateTableColumns(
  database: DatabaseSync,
  tableName: string,
  expected: ReadonlyArray<{
    name: string;
    type: string;
    notNull: boolean;
    primaryKey: boolean;
  }>,
): void {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all();
  if (rows.length !== expected.length) {
    throw new WhatsAppAuthStoreSchemaError(
      "The WhatsApp auth-store database has an unexpected column layout.",
    );
  }

  for (let index = 0; index < expected.length; index += 1) {
    const row = rows[index];
    const column = expected[index];
    if (
      readStringProperty(row, "name", "Schema column name") !== column.name ||
      readStringProperty(row, "type", "Schema column type") !== column.type ||
      readIntegerProperty(row, "notnull", "Schema not-null flag") !== Number(column.notNull) ||
      readIntegerProperty(row, "pk", "Schema primary-key flag") !== Number(column.primaryKey)
    ) {
      throw new WhatsAppAuthStoreSchemaError(
        "The WhatsApp auth-store database has an unexpected column layout.",
      );
    }
  }
}

function readMetadata(database: DatabaseSync): Map<string, Buffer> {
  const rows = database.prepare(`SELECT name, value FROM ${METADATA_TABLE} ORDER BY name`).all();
  if (rows.length !== METADATA_NAMES.length) {
    throw new WhatsAppAuthStoreCorruptionError(
      "The WhatsApp auth-store metadata set is incomplete.",
    );
  }

  const metadata = new Map<string, Buffer>();
  for (let index = 0; index < rows.length; index += 1) {
    const name = readStringProperty(rows[index], "name", "Metadata name");
    if (name !== METADATA_NAMES[index]) {
      throw new WhatsAppAuthStoreCorruptionError(
        "The WhatsApp auth-store metadata set is invalid.",
      );
    }
    metadata.set(name, readBlobProperty(rows[index], "value"));
  }
  return metadata;
}

function requireMetadata(
  metadata: ReadonlyMap<string, Buffer>,
  name: (typeof METADATA_NAMES)[number],
  expectedLength?: number,
): Buffer {
  const value = metadata.get(name);
  if (!value || (expectedLength !== undefined && value.length !== expectedLength)) {
    throw new WhatsAppAuthStoreCorruptionError(
      "The WhatsApp auth-store metadata has an invalid value.",
    );
  }
  return value;
}

function verifyAllRecords(database: DatabaseSync, encryptionKey: Buffer): void {
  const rows = database.prepare(`SELECT record_id, envelope FROM ${RECORDS_TABLE}`).iterate();
  for (const row of rows) {
    const recordId = readBlobProperty(row, "record_id");
    if (recordId.length !== RECORD_ID_BYTES) {
      throw new WhatsAppAuthStoreCorruptionError(
        "A WhatsApp auth-store record identifier is corrupt.",
      );
    }
    verifyStoredValue(readBlobProperty(row, "envelope"), recordId, encryptionKey);
  }
}

function normalizeSignalKeyUpdates(
  updates: WhatsAppSignalKeyUpdates | undefined,
): SignalKeyMutation[] {
  if (updates === undefined) return [];
  const candidate: unknown = updates;
  if (!isObjectRecord(candidate)) {
    throw new WhatsAppAuthStoreConfigurationError(
      "Signal-key updates must be an object grouped by category.",
    );
  }

  const mutations: SignalKeyMutation[] = [];
  for (const category of Object.keys(updates).sort()) {
    validateIdentifier(category, "Signal-key category");
    const categoryUpdates = updates[category];
    const categoryCandidate: unknown = categoryUpdates;
    if (!isObjectRecord(categoryCandidate)) {
      throw new WhatsAppAuthStoreConfigurationError(
        "Each Signal-key category update must be an object.",
      );
    }
    for (const id of Object.keys(categoryUpdates).sort()) {
      validateIdentifier(id, "Signal-key identifier");
      const value = categoryUpdates[id];
      if (value === undefined) {
        throw new WhatsAppAuthStoreConfigurationError(
          "A Signal-key update must contain a value or null.",
        );
      }
      mutations.push({ category, id, value });
    }
  }
  return mutations;
}

function validateIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new WhatsAppAuthStoreConfigurationError(`${label} must not be empty.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES) {
    throw new WhatsAppAuthStoreConfigurationError(`${label} is too long.`);
  }
}

function credentialsRecordId(indexKey: Buffer): Buffer {
  return deriveRecordId(indexKey, ["credentials"]);
}

function signalKeyRecordId(indexKey: Buffer, category: string, id: string): Buffer {
  return deriveRecordId(indexKey, ["signal-key", category, id]);
}

function verifierRecordId(indexKey: Buffer): Buffer {
  return deriveRecordId(indexKey, ["verifier"]);
}

function deriveRecordId(indexKey: Buffer, parts: readonly string[]): Buffer {
  const hmac = createHmac("sha256", indexKey);
  for (const part of parts) {
    const encoded = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.length);
    hmac.update(length);
    hmac.update(encoded);
  }
  return hmac.digest();
}

function deriveKeys(rootKey: Buffer, salt: Buffer): DerivedKeys {
  return {
    encryptionKey: deriveKey(rootKey, salt, "encryption"),
    indexKey: deriveKey(rootKey, salt, "record-index"),
    checkKey: deriveKey(rootKey, salt, "key-check"),
  };
}

function deriveKey(rootKey: Buffer, salt: Buffer, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      rootKey,
      salt,
      Buffer.from(`marshal-whatsapp-auth-store:${purpose}:v1`, "utf8"),
      DERIVED_KEY_BYTES,
    ),
  );
}

function computeKeyCheck(checkKey: Buffer): Buffer {
  return createHmac("sha256", checkKey).update(KEY_CHECK_CONTEXT).digest();
}

function computeMetadataDigest(salt: Buffer, keyCheck: Buffer): Buffer {
  return createHash("sha256")
    .update(METADATA_DIGEST_CONTEXT)
    .update(salt)
    .update(keyCheck)
    .digest();
}

function encryptEnvelope(plaintext: Buffer, recordId: Buffer, encryptionKey: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(envelopeAad(recordId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([
    ENVELOPE_MAGIC,
    Buffer.from([ENVELOPE_VERSION]),
    nonce,
    authTag,
    ciphertext,
  ]);
}

function decryptEnvelope(envelope: Buffer, recordId: Buffer, encryptionKey: Buffer): Buffer {
  if (
    envelope.length < ENVELOPE_HEADER_BYTES ||
    !envelope.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC) ||
    envelope[ENVELOPE_MAGIC.length] !== ENVELOPE_VERSION
  ) {
    throw new WhatsAppAuthStoreCorruptionError(
      "A WhatsApp auth-store encryption envelope is invalid.",
    );
  }

  const nonceStart = ENVELOPE_MAGIC.length + 1;
  const authTagStart = nonceStart + NONCE_BYTES;
  const ciphertextStart = authTagStart + AUTH_TAG_BYTES;
  const nonce = envelope.subarray(nonceStart, authTagStart);
  const authTag = envelope.subarray(authTagStart, ciphertextStart);
  const ciphertext = envelope.subarray(ciphertextStart);

  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(envelopeAad(recordId));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new WhatsAppAuthStoreCorruptionError(
      "A WhatsApp auth-store record failed authenticated decryption.",
      { cause: error },
    );
  }
}

function envelopeAad(recordId: Buffer): Buffer {
  return Buffer.concat([
    ENVELOPE_AAD_CONTEXT,
    ENVELOPE_MAGIC,
    Buffer.from([ENVELOPE_VERSION]),
    recordId,
  ]);
}

function decodeStoredValue(
  envelope: Buffer,
  recordId: Buffer,
  encryptionKey: Buffer,
): WhatsAppAuthStoreValue {
  const plaintext = decryptEnvelope(envelope, recordId, encryptionKey);
  let value: unknown;
  try {
    // V8 may use this buffer as backing storage for returned typed arrays.
    value = deserialize(plaintext);
  } catch (error) {
    plaintext.fill(0);
    throw new WhatsAppAuthStoreCorruptionError(
      "A WhatsApp auth-store record has an invalid serialized payload.",
      { cause: error },
    );
  }
  if (!isAuthStoreValue(value)) {
    plaintext.fill(0);
    throw new WhatsAppAuthStoreCorruptionError(
      "A WhatsApp auth-store record contains a reserved payload value.",
    );
  }
  return value;
}

function verifyStoredValue(envelope: Buffer, recordId: Buffer, encryptionKey: Buffer): void {
  const plaintext = decryptEnvelope(envelope, recordId, encryptionKey);
  try {
    deserialize(plaintext);
  } catch (error) {
    throw new WhatsAppAuthStoreCorruptionError(
      "A WhatsApp auth-store record has an invalid serialized payload.",
      { cause: error },
    );
  } finally {
    plaintext.fill(0);
  }
}

function readPragmaInteger(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  return readIntegerProperty(row, pragma, `SQLite ${pragma}`);
}

function readUserTableNames(database: DatabaseSync): string[] {
  return database
    .prepare(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map((row) => readStringProperty(row, "name", "SQLite table name"));
}

function readBlobProperty(row: unknown, property: string): Buffer {
  const value = readProperty(row, property);
  if (!(value instanceof Uint8Array)) {
    throw new WhatsAppAuthStoreCorruptionError(
      "The WhatsApp auth-store database contains a non-binary value.",
    );
  }
  return Buffer.from(value);
}

function readStringProperty(row: unknown, property: string, label: string): string {
  const value = readProperty(row, property);
  if (typeof value !== "string") {
    throw new WhatsAppAuthStoreCorruptionError(`${label} is invalid.`);
  }
  return value;
}

function readIntegerProperty(row: unknown, property: string, label: string): number {
  const value = readProperty(row, property);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new WhatsAppAuthStoreCorruptionError(`${label} is invalid.`);
  }
  return value;
}

function readProperty(row: unknown, property: string): unknown {
  if (!isObjectRecord(row) || !(property in row)) {
    throw new WhatsAppAuthStoreCorruptionError(
      "The WhatsApp auth-store database returned an invalid row.",
    );
  }
  return row[property];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthStoreValue(value: unknown): value is WhatsAppAuthStoreValue {
  return (
    value !== null &&
    (typeof value === "object" ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint")
  );
}

function rollback(database: DatabaseSync): Error | undefined {
  try {
    database.exec("ROLLBACK");
    return undefined;
  } catch (error) {
    return normalizeThrownError(error);
  }
}

function closeAfterFailedOpen(database: DatabaseSync | undefined): Error | undefined {
  if (!database) return undefined;
  try {
    database.close();
    return undefined;
  } catch (error) {
    return normalizeThrownError(error);
  }
}

function zeroStoreKeys(keys: StoreKeys | undefined): void {
  keys?.encryptionKey.fill(0);
  keys?.indexKey.fill(0);
}

function normalizeThrownError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("A non-Error value was thrown.", { cause: error });
}
