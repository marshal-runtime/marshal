import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  loadOrCreateKey: vi.fn<() => Buffer | null>(() => Buffer.alloc(32, 1)),
  readEncryptedFile: vi.fn<(filePath: string) => Promise<string>>(),
  writeEncryptedFile: vi.fn<(filePath: string, content: string) => Promise<void>>(),
}));

vi.mock("../safe-storage-file", () => storageMocks);

import { EncryptedExternalOperationPersistence } from "./store";

describe("EncryptedExternalOperationPersistence", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "external-operation-store-"));
    filePath = path.join(tempDir, "operations.enc");
    storageMocks.loadOrCreateKey.mockReturnValue(Buffer.alloc(32, 1));
    storageMocks.readEncryptedFile.mockReset();
    storageMocks.writeEncryptedFile.mockReset();
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test("rejects plaintext persistence", async () => {
    await fs.promises.writeFile(filePath, '{"version":1,"records":[]}');
    const persistence = new EncryptedExternalOperationPersistence(filePath);

    await expect(persistence.load()).rejects.toThrow("External-operation store is not encrypted");
    expect(storageMocks.writeEncryptedFile).not.toHaveBeenCalled();
  });

  test("requires device encryption for reads and writes", async () => {
    storageMocks.loadOrCreateKey.mockReturnValue(null);
    const persistence = new EncryptedExternalOperationPersistence(filePath);

    await expect(persistence.load()).rejects.toThrow(
      "Encrypted external-operation persistence is unavailable",
    );
    await expect(persistence.save("{}")).rejects.toThrow(
      "Encrypted external-operation persistence is unavailable",
    );
  });
});
