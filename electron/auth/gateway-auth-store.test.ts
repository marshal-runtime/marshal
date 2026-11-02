import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearGatewayAuthCred,
  loadGatewayAuthCred,
  saveGatewayAuthCred,
} from "./gateway-auth-store";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gateway-auth-store-test-"));
}

let tempHome: string;

beforeEach(() => {
  tempHome = makeTempDir();
  process.env.MARSHAL_GATEWAY_AUTH_DIR = tempHome;
});

afterEach(() => {
  delete process.env.MARSHAL_GATEWAY_AUTH_DIR;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("gateway-auth-store", () => {
  it("returns null when no cred file exists", () => {
    expect(loadGatewayAuthCred()).toBeNull();
  });

  it("round-trips a no-auth cred", () => {
    saveGatewayAuthCred({ mode: "no-auth" });
    expect(loadGatewayAuthCred()).toEqual({ mode: "no-auth" });
  });

  it("returns null when on-disk cred has a legacy fake-jwt mode", () => {
    // Locks in the silent-drop migration: users upgrading from a build
    // that supported fake-jwt should land back on the AAD login screen,
    // not see a thrown error or a half-rehydrated identity.
    const file = path.join(tempHome, "marshal-gateway-auth.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ mode: "fake-jwt", oid: "alice", tid: "tenant-dev" }),
      "utf8",
    );
    expect(loadGatewayAuthCred()).toBeNull();
  });

  it("clear removes the file", () => {
    saveGatewayAuthCred({ mode: "no-auth" });
    clearGatewayAuthCred();
    expect(loadGatewayAuthCred()).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const file = path.join(tempHome, "marshal-gateway-auth.json");
    fs.writeFileSync(file, "{not valid json");
    expect(loadGatewayAuthCred()).toBeNull();
  });

  it("returns null on unknown mode (schema mismatch)", () => {
    const file = path.join(tempHome, "marshal-gateway-auth.json");
    fs.writeFileSync(file, JSON.stringify({ mode: "definitely-not-a-mode" }));
    expect(loadGatewayAuthCred()).toBeNull();
  });

  it("round-trips an AAD cred with roleMode='operator-and-node'", () => {
    saveGatewayAuthCred({ mode: "hosted", roleMode: "operator-and-node" });
    expect(loadGatewayAuthCred()).toEqual({ mode: "hosted", roleMode: "operator-and-node" });
  });

  it("round-trips an AAD cred with roleMode='node'", () => {
    saveGatewayAuthCred({ mode: "hosted", roleMode: "node" });
    expect(loadGatewayAuthCred()).toEqual({ mode: "hosted", roleMode: "node" });
  });

  it("preserves a missing roleMode (back-compat with pre-roleMode auth files)", () => {
    // An older Marshal install would have written just `{ mode: "hosted" }`.
    // Loader must not invent a roleMode; the controller's downstream
    // operator-default fallback handles the absence.
    const file = path.join(tempHome, "marshal-gateway-auth.json");
    fs.writeFileSync(file, JSON.stringify({ mode: "hosted" }));
    expect(loadGatewayAuthCred()).toEqual({ mode: "hosted" });
  });

  it("drops an unknown roleMode rather than rejecting the whole cred", () => {
    // A future enum addition (e.g. "node-with-x") should not orphan a
    // user's auth-mode choice on an older client launch — drop just the
    // unknown roleMode and let the controller's default path take over.
    const file = path.join(tempHome, "marshal-gateway-auth.json");
    fs.writeFileSync(file, JSON.stringify({ mode: "hosted", roleMode: "future-mode" }));
    expect(loadGatewayAuthCred()).toEqual({ mode: "hosted" });
  });

  it("round-trips a nodeName alongside roleMode", () => {
    saveGatewayAuthCred({
      mode: "hosted",
      roleMode: "operator-and-node",
      nodeName: "harry's MacBook",
    });
    expect(loadGatewayAuthCred()).toEqual({
      mode: "hosted",
      roleMode: "operator-and-node",
      nodeName: "harry's MacBook",
    });
  });

  it("trims surrounding whitespace from a stored nodeName", () => {
    const file = path.join(tempHome, "marshal-gateway-auth.json");
    fs.writeFileSync(file, JSON.stringify({ mode: "hosted", nodeName: "  laptop  " }));
    expect(loadGatewayAuthCred()).toEqual({ mode: "hosted", nodeName: "laptop" });
  });

  it("drops an empty / whitespace-only nodeName so the controller can fall back to the OS hostname", () => {
    const file = path.join(tempHome, "marshal-gateway-auth.json");
    fs.writeFileSync(file, JSON.stringify({ mode: "hosted", nodeName: "   " }));
    expect(loadGatewayAuthCred()).toEqual({ mode: "hosted" });
  });
});
