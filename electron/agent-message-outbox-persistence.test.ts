import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  loadOrCreateKey: vi.fn<() => Buffer | null>(() => Buffer.alloc(32, 1)),
  readEncryptedFile: vi.fn<(filePath: string) => Promise<string>>(),
  writeEncryptedFile: vi.fn<(filePath: string, content: string) => Promise<void>>(),
}));

vi.mock("./safe-storage-file", () => storageMocks);

import { EncryptedAgentMessageOutboxPersistence } from "./agent-message-outbox";

describe("EncryptedAgentMessageOutboxPersistence", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-message-outbox-"));
    filePath = path.join(tempDir, "outbox.enc");
    storageMocks.loadOrCreateKey.mockReturnValue(Buffer.alloc(32, 1));
    storageMocks.readEncryptedFile.mockReset();
    storageMocks.writeEncryptedFile.mockReset();
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test("rejects a plaintext outbox without passing it to the shared legacy reader", async () => {
    await fs.promises.writeFile(filePath, '{"version":1}');
    const persistence = new EncryptedAgentMessageOutboxPersistence(filePath);

    await expect(persistence.load()).rejects.toThrow("Agent-message outbox is not encrypted");
    expect(storageMocks.readEncryptedFile).not.toHaveBeenCalled();
  });

  test("loads a file with the encrypted envelope magic", async () => {
    await fs.promises.writeFile(filePath, Buffer.from([0x4d, 0x53, 0x45, 0x01, 0, 0, 0, 0]));
    storageMocks.readEncryptedFile.mockResolvedValue('{"version":1}');
    const persistence = new EncryptedAgentMessageOutboxPersistence(filePath);

    await expect(persistence.load()).resolves.toBe('{"version":1}');
    expect(storageMocks.readEncryptedFile).toHaveBeenCalledWith(filePath);
  });

  test("refuses reads and writes when device encryption is unavailable", async () => {
    storageMocks.loadOrCreateKey.mockReturnValue(null);
    const persistence = new EncryptedAgentMessageOutboxPersistence(filePath);

    await expect(persistence.load()).rejects.toThrow(
      "Encrypted agent-message persistence is unavailable",
    );
    await expect(persistence.save("content")).rejects.toThrow(
      "Encrypted agent-message persistence is unavailable",
    );
    expect(storageMocks.writeEncryptedFile).not.toHaveBeenCalled();
  });
});