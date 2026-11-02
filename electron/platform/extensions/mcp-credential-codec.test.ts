import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomMcpServer } from "../../ipc/types";
import type { PersistedCustomMcpServer } from "./mcp-credential-codec";

const { mockEncryptString, mockDecryptString, mockIsEncryptionAvailable, mockIsReady, appState } =
  vi.hoisted(() => ({
    mockEncryptString: vi.fn<(s: string) => Buffer>((s: string) => Buffer.from(`enc:${s}`)),
    mockDecryptString: vi.fn<(b: Buffer) => string>((b: Buffer) =>
      b.toString().replace(/^enc:/, ""),
    ),
    mockIsEncryptionAvailable: vi.fn<() => boolean>(() => true),
    mockIsReady: vi.fn<() => boolean>(() => true),
    appState: { isPackaged: false },
  }));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: mockIsEncryptionAvailable,
    encryptString: mockEncryptString,
    decryptString: mockDecryptString,
  },
  app: {
    isReady: mockIsReady,
    get isPackaged() {
      return appState.isPackaged;
    },
  },
}));

import { deserializeServer, serializeServer } from "./mcp-credential-codec";

const remoteWithToken = {
  name: "r",
  url: "https://r.example.com",
  accessToken: "tok",
} as CustomMcpServer;

const persistedWithToken = {
  name: "r",
  url: "https://r.example.com",
  accessTokenEncrypted: Buffer.from("enc:tok").toString("base64"),
} as PersistedCustomMcpServer;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEncryptionAvailable.mockReturnValue(true);
  mockEncryptString.mockImplementation((s: string) => Buffer.from(`enc:${s}`));
  mockDecryptString.mockImplementation((b: Buffer) => b.toString().replace(/^enc:/, ""));
  mockIsReady.mockReturnValue(true);
  appState.isPackaged = false;
});

describe("mcp-crypto pre-app-ready guard (Electron #45328)", () => {
  it("serializeServer throws when safeStorage is touched before app ready (dev)", () => {
    mockIsReady.mockReturnValue(false);
    expect(() => serializeServer(remoteWithToken)).toThrow(/before app ready/);
  });

  it("deserializeServer throws when safeStorage is touched before app ready (dev)", () => {
    mockIsReady.mockReturnValue(false);
    expect(() => deserializeServer(persistedWithToken)).toThrow(/before app ready/);
  });

  it("does not throw in a packaged build — logs instead", () => {
    mockIsReady.mockReturnValue(false);
    appState.isPackaged = true;
    expect(() => serializeServer(remoteWithToken)).not.toThrow();
  });

  it("does not guard once the app is ready", () => {
    expect(() => serializeServer(remoteWithToken)).not.toThrow();
    const out = deserializeServer(persistedWithToken);
    expect("accessToken" in out && out.accessToken).toBe("tok");
  });

  it("skips the guard when app is unavailable (e.g. pure unit test)", () => {
    mockIsReady.mockImplementation(() => {
      throw new Error("app not available");
    });
    expect(() => serializeServer(remoteWithToken)).not.toThrow();
  });
});
