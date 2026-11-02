import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, it, expect, afterEach } from "vitest";

import {
  computeDeviceId,
  DeviceIdentityError,
  readDeviceIdentity,
  resolveDeviceIdentityPath,
  signChallenge,
} from "./device-identity";
import type { DeviceIdentity } from "./device-identity";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a fresh Ed25519 keypair and return a DeviceIdentity. */
function makeTestIdentity(): {
  identity: DeviceIdentity;
  publicKeyObject: crypto.KeyObject;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

  // Export raw public key bytes (32 bytes for Ed25519)
  const rawPublicKey = publicKey.export({ type: "spki", format: "der" });
  // SPKI wraps 32 raw bytes with a 12-byte header — raw key starts at offset 12
  const rawPublicKeyBytes = rawPublicKey.subarray(12);
  const publicKeyBase64url = rawPublicKeyBytes.toString("base64url");
  const deviceId = crypto.createHash("sha256").update(rawPublicKeyBytes).digest("hex");

  return {
    identity: { deviceId, publicKeyBase64url, privateKey },
    publicKeyObject: publicKey,
  };
}

// ── Device ID computation ────────────────────────────────────────────────────

describe("computeDeviceId", () => {
  it("returns SHA-256 hex of the raw public key bytes", () => {
    const { identity, publicKeyObject } = makeTestIdentity();

    // Independently compute expected device ID
    const rawPublicKey = publicKeyObject.export({ type: "spki", format: "der" });
    const rawBytes = rawPublicKey.subarray(12);
    const expected = crypto.createHash("sha256").update(rawBytes).digest("hex");

    expect(computeDeviceId(identity.publicKeyBase64url)).toBe(expected);
  });

  it("produces a 64-character hex string", () => {
    const { identity } = makeTestIdentity();
    const result = computeDeviceId(identity.publicKeyBase64url);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the pre-computed device_id in the adapter identity file spec", () => {
    // Values from the adapter file format described in the spec
    const publicKeyB64 = "Tn_BtcX1VwzhqToEEeSH_1nGaPOiFl-Kldw_QWY3_K8";
    const expectedDeviceId = "3af9297a9ebb1d16cb17828ff890fffe61dcee14e656bb2e3d381016a01afbf2";
    expect(computeDeviceId(publicKeyB64)).toBe(expectedDeviceId);
  });
});

// ── signChallenge ────────────────────────────────────────────────────────────

describe("signChallenge", () => {
  it("produces a valid Ed25519 signature that verifies with the public key", () => {
    const { identity, publicKeyObject } = makeTestIdentity();
    const challenge = { nonce: "abc123nonce", ts: 1700000000, token: "tok_test" };

    const signed = signChallenge(identity, challenge);

    // Reconstruct the payload the same way the implementation does
    const payload = [
      "v2",
      identity.deviceId,
      "gateway-client",
      "backend",
      "operator",
      "operator.read,operator.write,operator.admin,operator.approvals",
      String(challenge.ts),
      challenge.token,
      challenge.nonce,
    ].join("|");

    const sigBuffer = Buffer.from(signed.signatureBase64url, "base64url");
    const valid = crypto.verify(null, Buffer.from(payload), publicKeyObject, sigBuffer);
    expect(valid).toBe(true);
  });

  it("returns the correct deviceId and publicKeyBase64url", () => {
    const { identity } = makeTestIdentity();
    const challenge = { nonce: "nonce42", ts: 1700000001, token: "tok_x" };

    const signed = signChallenge(identity, challenge);

    expect(signed.deviceId).toBe(identity.deviceId);
    expect(signed.publicKeyBase64url).toBe(identity.publicKeyBase64url);
  });

  it("sets signedAt to the ts from the challenge", () => {
    const { identity } = makeTestIdentity();
    const ts = 1700000042;
    const signed = signChallenge(identity, { nonce: "n", ts, token: "t" });
    expect(signed.signedAt).toBe(ts);
  });

  it("produces a base64url-encoded signature (no +, /, or =)", () => {
    const { identity } = makeTestIdentity();
    const signed = signChallenge(identity, { nonce: "n2", ts: 1, token: "t2" });
    expect(signed.signatureBase64url).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("different nonces produce different signatures", () => {
    const { identity } = makeTestIdentity();
    const base = { ts: 1700000000, token: "tok" };
    const s1 = signChallenge(identity, { ...base, nonce: "nonce_a" });
    const s2 = signChallenge(identity, { ...base, nonce: "nonce_b" });
    expect(s1.signatureBase64url).not.toBe(s2.signatureBase64url);
  });
});

// ── readDeviceIdentity ───────────────────────────────────────────────────────

describe("readDeviceIdentity", () => {
  const tmpFiles: string[] = [];
  const tmpDirs: string[] = [];

  function writeTempFile(content: string): string {
    const filePath = path.join(os.tmpdir(), `test-identity-${crypto.randomUUID()}.json`);
    fs.writeFileSync(filePath, content, "utf8");
    tmpFiles.push(filePath);
    return filePath;
  }

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore cleanup errors
      }
    }
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the Marshal Gateway identity path by default", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-id-home-"));
    tmpDirs.push(homeDir);

    const resolved = resolveDeviceIdentityPath(homeDir, "");

    expect(resolved).toBe(path.join(homeDir, ".marshal", "marshal", "device-identity.json"));
  });

  it("keeps the Gateway-owned identity override unchanged", () => {
    expect(resolveDeviceIdentityPath("/home/user", "/custom/device-identity.json")).toBe(
      "/custom/device-identity.json",
    );
  });

  it("reads a valid adapter identity file and returns a DeviceIdentity", () => {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

    const publicKey = crypto.createPublicKey(privateKey);
    const rawSpki = publicKey.export({ type: "spki", format: "der" });
    const rawBytes = rawSpki.subarray(12);
    const publicKeyB64 = rawBytes.toString("base64url");
    const deviceId = crypto.createHash("sha256").update(rawBytes).digest("hex");

    const fileContent = JSON.stringify({
      device_id: deviceId,
      public_key_b64: publicKeyB64,
      private_key_pem: privatePem,
    });

    const filePath = writeTempFile(fileContent);
    const identity = readDeviceIdentity(filePath);

    expect(identity.deviceId).toBe(deviceId);
    expect(identity.publicKeyBase64url).toBe(publicKeyB64);
    expect(identity.privateKey).toBeDefined();
  });

  it("parses the private key so it can be used for signing", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

    const rawSpki = publicKey.export({ type: "spki", format: "der" });
    const rawBytes = rawSpki.subarray(12);
    const publicKeyB64 = rawBytes.toString("base64url");
    const deviceId = crypto.createHash("sha256").update(rawBytes).digest("hex");

    const filePath = writeTempFile(
      JSON.stringify({
        device_id: deviceId,
        public_key_b64: publicKeyB64,
        private_key_pem: privatePem,
      }),
    );

    const identity = readDeviceIdentity(filePath);

    // Sign something to confirm the parsed key is usable
    const sig = crypto.sign(null, Buffer.from("test payload"), identity.privateKey);
    const valid = crypto.verify(null, Buffer.from("test payload"), publicKey, sig);
    expect(valid).toBe(true);
  });

  it("computed device_id matches SHA-256 of the decoded public key", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

    const rawSpki = publicKey.export({ type: "spki", format: "der" });
    const rawBytes = rawSpki.subarray(12);
    const publicKeyB64 = rawBytes.toString("base64url");
    const deviceId = crypto.createHash("sha256").update(rawBytes).digest("hex");

    const filePath = writeTempFile(
      JSON.stringify({
        device_id: deviceId,
        public_key_b64: publicKeyB64,
        private_key_pem: privatePem,
      }),
    );

    const identity = readDeviceIdentity(filePath);

    // Verify device_id matches SHA-256 of the raw public key from public_key_b64
    expect(computeDeviceId(identity.publicKeyBase64url)).toBe(identity.deviceId);
  });

  it("throws DeviceIdentityError when the file is missing required fields", () => {
    // Tagged as DeviceIdentityError (not a plain Error) so the reconnect loop
    // can distinguish non-recoverable config errors from network blips.
    const filePath = writeTempFile(JSON.stringify({ device_id: "abc" }));
    expect(() => readDeviceIdentity(filePath)).toThrow(DeviceIdentityError);
    expect(() => readDeviceIdentity(filePath)).toThrow(/missing required fields/);
  });

  it("throws DeviceIdentityError when the file is not valid JSON", () => {
    const filePath = writeTempFile("{not valid json");
    expect(() => readDeviceIdentity(filePath)).toThrow(DeviceIdentityError);
    expect(() => readDeviceIdentity(filePath)).toThrow(/Invalid JSON/);
  });

  it("throws DeviceIdentityError when the PEM is malformed", () => {
    const filePath = writeTempFile(
      JSON.stringify({
        device_id: "abc123",
        public_key_b64: "Tn_BtcX1VwzhqToEEeSH_1nGaPOiFl-Kldw_QWY3_K8",
        private_key_pem:
          "-----BEGIN PRIVATE KEY-----\nNOT_A_VALID_KEY\n-----END PRIVATE KEY-----\n",
      }),
    );
    expect(() => readDeviceIdentity(filePath)).toThrow(DeviceIdentityError);
    expect(() => readDeviceIdentity(filePath)).toThrow(/Invalid private key PEM/);
  });

  it("generates a new identity when file does not exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-id-"));
    const filePath = path.join(tmpDir, "identity.json");

    expect(fs.existsSync(filePath)).toBe(false);
    const identity = readDeviceIdentity(filePath);

    expect(identity.deviceId).toBeTruthy();
    expect(identity.publicKeyBase64url).toBeTruthy();
    expect(identity.privateKey).toBeTruthy();
    expect(fs.existsSync(filePath)).toBe(true); // File was created
    // Self-consistency on the generated pair — the deviceId the file was
    // written with must be SHA-256 of the public key it was written with.
    // Without this, a buggy generator could persist mismatched fields.
    expect(computeDeviceId(identity.publicKeyBase64url)).toBe(identity.deviceId);

    // Verify the file can be re-read
    const reread = readDeviceIdentity(filePath);
    expect(reread.deviceId).toBe(identity.deviceId);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("reads the spec adapter identity file format (with real private_key_pem)", () => {
    // This is the exact shape from the spec — validates the format works end-to-end
    const specFile = JSON.stringify({
      device_id: "3af9297a9ebb1d16cb17828ff890fffe61dcee14e656bb2e3d381016a01afbf2",
      public_key_b64: "Tn_BtcX1VwzhqToEEeSH_1nGaPOiFl-Kldw_QWY3_K8",
      private_key_pem:
        "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAeyTMsfevEi9YaRcFQY1qEh8sYq+hIAOAPddc0d39bF\n-----END PRIVATE KEY-----\n",
    });

    const filePath = writeTempFile(specFile);
    const identity = readDeviceIdentity(filePath);

    expect(identity.deviceId).toBe(
      "3af9297a9ebb1d16cb17828ff890fffe61dcee14e656bb2e3d381016a01afbf2",
    );
    expect(identity.publicKeyBase64url).toBe("Tn_BtcX1VwzhqToEEeSH_1nGaPOiFl-Kldw_QWY3_K8");

    // Verify the parsed device_id matches SHA-256 of public_key_b64
    expect(computeDeviceId(identity.publicKeyBase64url)).toBe(identity.deviceId);
  });
});
