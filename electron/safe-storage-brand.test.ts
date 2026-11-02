import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  finalizeSafeStorageAppName,
  prepareSafeStorageAppName,
  resolveCommandLineUserDataDir,
  userDataPath,
} from "./safe-storage-brand";

describe("safeStorage app-name identity", () => {
  it("uses the Marshal keychain name", () => {
    const calls: string[] = [];
    const app = {
      setName: vi.fn<(name: string) => void>((name) => {
        calls.push(`name:${name}`);
      }),
    };
    const safeStorage = {
      isEncryptionAvailable: vi.fn<() => boolean>(() => {
        calls.push("safeStorage:available");
        return true;
      }),
      encryptString: vi.fn<(value: string) => Buffer>(() => {
        calls.push("safeStorage:encrypt");
        return Buffer.alloc(0);
      }),
    };

    prepareSafeStorageAppName(app);
    finalizeSafeStorageAppName(app, safeStorage);

    expect(calls).toEqual([
      "name:Marshal",
      "safeStorage:available",
      "safeStorage:encrypt",
      "name:Marshal",
    ]);
  });

  it("uses the same Marshal identity on Windows", () => {
    const calls: string[] = [];
    const app = { setName: vi.fn<(name: string) => void>() };
    app.setName.mockImplementation((name) => {
      calls.push(`name:${name}`);
    });
    const safeStorage = {
      isEncryptionAvailable: vi.fn<() => boolean>(() => false),
      encryptString: vi.fn<(value: string) => Buffer>(),
    };

    prepareSafeStorageAppName(app);
    finalizeSafeStorageAppName(app, safeStorage);

    expect(calls).toEqual(["name:Marshal", "name:Marshal"]);
    expect(safeStorage.isEncryptionAvailable).toHaveBeenCalledOnce();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it("uses the Marshal userData identity", () => {
    expect(userDataPath("/app-data")).toBe(path.join("/app-data", "Marshal"));
  });

  it("accepts only an absolute command-line userData override", () => {
    expect(resolveCommandLineUserDataDir("")).toBeNull();
    expect(resolveCommandLineUserDataDir("   ")).toBeNull();
    expect(resolveCommandLineUserDataDir(path.join(path.sep, "bounded", "electron-data"))).toBe(
      path.resolve(path.sep, "bounded", "electron-data"),
    );
    expect(() => resolveCommandLineUserDataDir("relative\\electron-data")).toThrow(
      "Electron user-data directory must be absolute.",
    );
  });
});
