import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EncryptedWhatsAppAuthStore,
  WhatsAppAuthStoreCorruptionError,
  WhatsAppAuthStoreTransactionError,
  WhatsAppAuthStoreWrongKeyError,
} from "./auth-store";

type DatabaseSync = import("node:sqlite").DatabaseSync;

let tempDirectory: string;
let databasePath: string;
let keyMaterial: Buffer;
let openStores: EncryptedWhatsAppAuthStore[];

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-auth-store-"));
  databasePath = path.join(tempDirectory, "auth.db");
  keyMaterial = randomBytes(32);
  openStores = [];
});

afterEach(() => {
  for (const store of openStores) store.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe("EncryptedWhatsAppAuthStore", () => {
  it("atomically stores credentials and multiple Signal-key categories", () => {
    const store = openStore();
    const credentials = {
      registrationId: 42,
      identityKey: Buffer.from([1, 2, 3, 4]),
      account: { linked: true },
    };
    const preKey = new Uint8Array([5, 6, 7]);
    const session = { chainKey: Buffer.from([8, 9]), counter: 7n };

    store.applyTransaction({
      credentials,
      signalKeys: {
        "pre-key": { "17": preKey, "18": Buffer.from([10, 11]) },
        session: { "device-a": session },
      },
    });

    expect(store.readCredentials()).toEqual(credentials);
    expect(store.readSignalKeys("pre-key", ["17", "18", "missing"])).toEqual({
      "17": preKey,
      "18": Buffer.from([10, 11]),
    });
    expect(store.readSignalKeys("session", ["device-a"])).toEqual({
      "device-a": session,
    });
  });

  it("rolls back every write when a later mutation fails", () => {
    const store = openStore();
    store.applyTransaction({ credentials: { generation: 1 } });

    withRawDatabase((database) => {
      database.exec(`
        CREATE TRIGGER fail_second_new_record
        BEFORE INSERT ON auth_store_records
        WHEN (SELECT COUNT(*) FROM auth_store_records) >= 2
        BEGIN
          SELECT RAISE(ABORT, 'forced transactional rollback');
        END;
      `);
    });

    expect(() =>
      store.applyTransaction({
        credentials: { generation: 2 },
        signalKeys: {
          session: {
            first: Buffer.from("first"),
            second: Buffer.from("second"),
          },
        },
      }),
    ).toThrow(WhatsAppAuthStoreTransactionError);

    expect(store.readCredentials()).toEqual({ generation: 1 });
    expect(store.readSignalKeys("session", ["first", "second"])).toEqual({});
  });

  it("recovers credentials and binary Signal keys after restart", () => {
    const first = openStore();
    first.applyTransaction({
      credentials: { noiseKey: Buffer.from([21, 22]), registered: true },
      signalKeys: {
        "sender-key": {
          group: new Uint8Array([23, 24, 25]),
        },
      },
    });
    first.close();

    const reopened = openStore();
    expect(reopened.readCredentials()).toEqual({
      noiseKey: Buffer.from([21, 22]),
      registered: true,
    });
    expect(reopened.readSignalKeys("sender-key", ["group"])).toEqual({
      group: new Uint8Array([23, 24, 25]),
    });
  });

  it("rejects the store explicitly when opened with the wrong key", () => {
    const store = openStore();
    store.applyTransaction({ credentials: { registered: true } });
    store.close();

    expect(() =>
      EncryptedWhatsAppAuthStore.open({
        databasePath,
        keyMaterial: randomBytes(32),
      }),
    ).toThrow(WhatsAppAuthStoreWrongKeyError);
  });

  it("detects authenticated-record corruption during reopen", () => {
    const store = openStore();
    store.applyTransaction({
      credentials: { marker: "corruption-target" },
      signalKeys: { session: { device: Buffer.from([31, 32, 33]) } },
    });
    store.close();

    withRawDatabase((database) => {
      const row = database
        .prepare("SELECT record_id, envelope FROM auth_store_records ORDER BY record_id LIMIT 1")
        .get();
      const recordId = readBlob(row, "record_id");
      const envelope = readBlob(row, "envelope");
      envelope[envelope.length - 1] ^= 0xff;
      database
        .prepare("UPDATE auth_store_records SET envelope = ? WHERE record_id = ?")
        .run(envelope, recordId);
    });

    expect(() =>
      EncryptedWhatsAppAuthStore.open({
        databasePath,
        keyMaterial,
      }),
    ).toThrow(WhatsAppAuthStoreCorruptionError);
  });

  it("detects a malformed SQLite database before schema access", () => {
    fs.writeFileSync(databasePath, Buffer.from("not-a-sqlite-database", "utf8"));

    expect(() =>
      EncryptedWhatsAppAuthStore.open({
        databasePath,
        keyMaterial,
      }),
    ).toThrow(WhatsAppAuthStoreCorruptionError);
  });

  it("clears terminal-disconnect state atomically and accepts a fresh relink", () => {
    const store = openStore();
    store.applyTransaction({
      credentials: { account: "old-account" },
      signalKeys: {
        session: { old: Buffer.from("old-session") },
        "pre-key": { old: Buffer.from("old-pre-key") },
      },
    });

    store.resetAfterTerminalDisconnect();
    expect(store.readCredentials()).toBeNull();
    expect(store.readSignalKeys("session", ["old"])).toEqual({});
    expect(store.readSignalKeys("pre-key", ["old"])).toEqual({});

    store.applyTransaction({
      credentials: { account: "new-account" },
      signalKeys: { session: { fresh: Buffer.from("new-session") } },
    });
    store.close();

    const reopened = openStore();
    expect(reopened.readCredentials()).toEqual({ account: "new-account" });
    expect(reopened.readSignalKeys("session", ["old", "fresh"])).toEqual({
      fresh: Buffer.from("new-session"),
    });
  });

  it("persists only the SQLite database, opaque identifiers, and encrypted envelopes", () => {
    const store = openStore();
    const credentialMarker = "credential-plaintext-must-not-appear";
    const categoryMarker = "category-plaintext-must-not-appear";
    const identifierMarker = "identifier-plaintext-must-not-appear";

    store.applyTransaction({
      credentials: { credentialMarker },
      signalKeys: {
        [categoryMarker]: {
          [identifierMarker]: Buffer.from("signal-key-plaintext-must-not-appear"),
        },
      },
    });
    store.close();

    expect(fs.readdirSync(tempDirectory)).toEqual(["auth.db"]);
    const databaseBytes = fs.readFileSync(databasePath);
    expect(databaseBytes.includes(keyMaterial)).toBe(false);
    expect(databaseBytes.includes(Buffer.from(credentialMarker))).toBe(false);
    expect(databaseBytes.includes(Buffer.from(categoryMarker))).toBe(false);
    expect(databaseBytes.includes(Buffer.from(identifierMarker))).toBe(false);
    expect(databaseBytes.includes(Buffer.from("signal-key-plaintext-must-not-appear"))).toBe(false);

    withRawDatabase((database) => {
      expect(readPragma(database, "application_id")).toBe(0x4d574153);
      expect(readPragma(database, "user_version")).toBe(1);
      expect(
        database
          .prepare("SELECT name FROM auth_store_metadata ORDER BY name")
          .all()
          .map((row) => readString(row, "name")),
      ).toEqual(["key_check", "metadata_digest", "store_salt", "verifier"]);

      const records = database.prepare("SELECT record_id, envelope FROM auth_store_records").all();
      expect(records).toHaveLength(2);
      for (const row of records) {
        expect(readBlob(row, "record_id")).toHaveLength(32);
        const envelope = readBlob(row, "envelope");
        expect(envelope.subarray(0, 4).toString("ascii")).toBe("MWAE");
        expect(envelope[4]).toBe(1);
      }
    });
  });
});

function openStore(): EncryptedWhatsAppAuthStore {
  const store = EncryptedWhatsAppAuthStore.open({ databasePath, keyMaterial });
  openStores.push(store);
  return store;
}

function withRawDatabase(operation: (database: DatabaseSync) => void): void {
  const sqlite = process.getBuiltinModule("node:sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (!sqlite) throw new Error("node:sqlite is required for this test.");

  const database = new sqlite.DatabaseSync(databasePath);
  try {
    operation(database);
  } finally {
    database.close();
  }
}

function readPragma(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  const value = readProperty(row, name);
  if (typeof value !== "number") throw new Error(`Expected numeric PRAGMA ${name}.`);
  return value;
}

function readBlob(row: unknown, property: string): Buffer {
  const value = readProperty(row, property);
  if (!(value instanceof Uint8Array)) throw new Error(`Expected binary ${property}.`);
  return Buffer.from(value);
}

function readString(row: unknown, property: string): string {
  const value = readProperty(row, property);
  if (typeof value !== "string") throw new Error(`Expected string ${property}.`);
  return value;
}

function readProperty(row: unknown, property: string): unknown {
  if (!isObjectRecord(row) || !(property in row)) {
    throw new Error(`Expected row property ${property}.`);
  }
  return row[property];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
