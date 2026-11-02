import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../testing/harness";
import {
  createRuntimeExtensionSecrets,
  type RuntimeExtensionSecretEncryption,
  type RuntimeExtensionSecrets,
} from "./extension-secrets";

const namespace = "@fixture/github-core:account-1";
const plaintext = "fixture-only-token-✓";

function harness(platform: NodeJS.Platform = "darwin") {
  const key = randomBytes(32);
  const isReady = vi.fn<() => boolean>(() => true);
  const encryption = {
    isEncryptionAvailable: vi.fn<() => boolean>(() => true),
    getSelectedStorageBackend: vi.fn<() => string>(() => "gnome_libsecret"),
    encryptString: vi.fn<RuntimeExtensionSecretEncryption["encryptString"]>((value) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    }),
    decryptString: vi.fn<RuntimeExtensionSecretEncryption["decryptString"]>((value) => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    }),
  };
  const options = { isReady, encryption, platform };
  return { options, encryption, isReady, secrets: createRuntimeExtensionSecrets(options) };
}

describe("native extension secrets", () => {
  it("returns only versioned ciphertext and opens it after recreating the module", () => {
    const h = harness();
    const sealed = h.secrets.seal({ namespace, plaintext });
    expect(sealed).toMatch(/^marshal-secret:v1:[A-Za-z0-9+/]+=*$/);
    expect(sealed).not.toContain(plaintext);
    expect(sealed).not.toContain(namespace);
    expect(createRuntimeExtensionSecrets(h.options).open({ namespace, sealed })).toBe(plaintext);
    expect(Object.isFrozen(h.secrets)).toBe(true);
    expect(h.encryption.getSelectedStorageBackend).not.toHaveBeenCalled();
  });

  it("does not touch safeStorage before readiness and refuses later keychain loss", () => {
    const h = harness();
    h.isReady.mockReturnValue(false);
    expect(h.secrets.isAvailable()).toBe(false);
    expect(() => h.secrets.seal({ namespace, plaintext })).toThrow("unavailable");
    expect(h.encryption.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(h.encryption.encryptString).not.toHaveBeenCalled();
    h.isReady.mockReturnValue(true);
    const sealed = h.secrets.seal({ namespace, plaintext });
    h.encryption.isEncryptionAvailable.mockReturnValue(false);
    expect(h.secrets.isAvailable()).toBe(false);
    expect(() => h.secrets.open({ namespace, sealed })).toThrow("unavailable");
    expect(() => h.secrets.seal({ namespace, plaintext })).toThrow("unavailable");
    expect(h.encryption.decryptString).not.toHaveBeenCalled();
    expect(h.encryption.encryptString).toHaveBeenCalledOnce();
  });

  it.each(["basic_text", "unknown", "unsupported"])("refuses the Linux %s backend", (backend) => {
    const h = harness("linux");
    h.encryption.getSelectedStorageBackend.mockReturnValue(backend);
    expect(h.secrets.isAvailable()).toBe(false);
    expect(() => h.secrets.seal({ namespace, plaintext })).toThrow("unavailable");
    expect(h.encryption.encryptString).not.toHaveBeenCalled();
  });

  it("requires a verifiable Linux backend and accepts secure Linux and Windows storage", () => {
    const h = harness("linux");
    expect(h.secrets.isAvailable()).toBe(true);
    const { getSelectedStorageBackend: _backend, ...encryption } = h.encryption;
    expect(createRuntimeExtensionSecrets({ ...h.options, encryption }).isAvailable()).toBe(false);
    expect(harness("win32").secrets.isAvailable()).toBe(true);
  });

  it("rejects tampering, other keys, and namespace mismatch without reflecting inputs", () => {
    const h = harness();
    const sealed = h.secrets.seal({ namespace, plaintext });
    expect(() => h.secrets.open({ namespace: "other", sealed })).toThrow("could not be opened");
    expect(() => harness().secrets.open({ namespace, sealed })).toThrow("could not be opened");
    const bytes = Buffer.from(sealed.slice("marshal-secret:v1:".length), "base64");
    bytes[bytes.length - 1] ^= 1;
    expect(() =>
      h.secrets.open({ namespace, sealed: "marshal-secret:v1:" + bytes.toString("base64") }),
    ).toThrow("could not be opened");
  });

  it("rejects oversized and malformed requests before encryption or decryption", () => {
    const h = harness();
    for (const request of [
      { namespace: "a".repeat(161), plaintext },
      { namespace: "", plaintext },
      { namespace: "has space", plaintext },
      { namespace, plaintext: "" },
      { namespace, plaintext: "é".repeat(32_769) },
      { namespace, plaintext: "\ud800" },
      { namespace, plaintext, extra: "ignored" },
    ]) {
      expect(() =>
        h.secrets.seal(testDouble<Parameters<RuntimeExtensionSecrets["seal"]>[0]>(request)),
      ).toThrow("Invalid extension secret");
    }
    for (const sealed of [
      "",
      "marshal-secret:v2:YWJj",
      "marshal-secret:v1:YWJj\n",
      "marshal-secret:v1:A===",
      "marshal-secret:v1:AB==",
      "marshal-secret:v1:" + "A".repeat(175_000),
    ]) {
      expect(() => h.secrets.open({ namespace, sealed })).toThrow("could not be opened");
    }
    expect(() => Reflect.apply(h.secrets.seal, undefined, [null])).toThrow(
      "Invalid extension secret",
    );
    expect(h.encryption.encryptString).not.toHaveBeenCalled();
    expect(h.encryption.decryptString).not.toHaveBeenCalled();
  });

  it("accepts the maximum plaintext byte count with bounded envelope expansion", () => {
    const h = harness();
    const value = "\u0000".repeat(64 * 1024);
    const sealed = h.secrets.seal({ namespace, plaintext: value });
    expect(h.secrets.open({ namespace, sealed })).toBe(value);
  });

  it("rejects invalid encrypted envelopes and oversized encryption output", () => {
    const h = harness();
    for (const envelope of [
      { version: 2, namespace, encoded: Buffer.from(plaintext).toString("base64") },
      { version: 1, namespace, encoded: "AB==" },
      { version: 1, namespace, encoded: Buffer.from([0xff]).toString("base64") },
      { version: 1, namespace, encoded: Buffer.from(plaintext).toString("base64"), extra: true },
    ]) {
      const sealed =
        "marshal-secret:v1:" +
        h.encryption.encryptString(JSON.stringify(envelope)).toString("base64");
      expect(() => h.secrets.open({ namespace, sealed })).toThrow("could not be opened");
    }
    h.encryption.encryptString.mockReturnValue(Buffer.alloc(128 * 1024 + 1));
    expect(() => h.secrets.seal({ namespace, plaintext })).toThrow("encryption failed");
    h.encryption.decryptString.mockReturnValue("a".repeat(96 * 1024 + 1));
    expect(() => h.secrets.open({ namespace, sealed: "marshal-secret:v1:YWJj" })).toThrow(
      "could not be opened",
    );
  });

  it("replaces OS error text with fixed errors and never includes a cause", () => {
    const h = harness();
    h.encryption.encryptString.mockImplementation(() => {
      throw new Error(plaintext);
    });
    let failure: unknown;
    try {
      h.secrets.seal({ namespace, plaintext });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "encryption_failed",
      message: "Extension secret encryption failed.",
    });
    expect(failure).not.toHaveProperty("cause");
    h.encryption.isEncryptionAvailable.mockImplementation(() => {
      throw new Error(plaintext);
    });
    expect(h.secrets.isAvailable()).toBe(false);
  });
});
