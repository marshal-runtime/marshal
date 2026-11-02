import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  readEncryptedFileReadOnly,
  writeEncryptedFile,
  writeEncryptedFileSync,
} from "./safe-storage-file";
import { LocalSessionStore, type PersistedSession } from "./session-store";
import { readRuntimeTranscript } from "./session-transcript";

const fixture = vi.hoisted(() => ({ directory: "" }));
vi.mock("./app-paths", () => ({ getAppDataDir: () => fixture.directory }));
vi.mock("./platform-security", () => ({
  secureMkdirSync: (directory: string) => fs.mkdirSync(directory, { recursive: true }),
}));
vi.mock("./telemetry-errors", () => ({
  sendErrorTelemetry: vi.fn<() => void>(),
  hasTelemetryMarker: () => false,
}));
vi.mock("./safe-storage-file", async () => {
  const disk = await import("node:fs");
  const crypto = await import("node:crypto");
  // Real encrypted fixture bytes; no operating-system credential APIs are used.
  const key = Buffer.alloc(32, 7);
  const encrypt = (text: string) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  };
  const decrypt = (bytes: Buffer) => {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  };
  return {
    readEncryptedFileReadOnly: vi.fn<(file: string) => Promise<string>>(async (file: string) =>
      decrypt(await disk.promises.readFile(file)),
    ),
    readEncryptedFileSync: vi.fn<(file: string) => string>((file: string) =>
      decrypt(disk.readFileSync(file)),
    ),
    writeEncryptedFile: vi.fn<(file: string, text: string) => Promise<void>>(
      async (file: string, text: string) => disk.promises.writeFile(file, encrypt(text)),
    ),
    writeEncryptedFileSync: vi.fn<(file: string, text: string) => void>(
      (file: string, text: string) => disk.writeFileSync(file, encrypt(text)),
    ),
  };
});

beforeEach(() => {
  fixture.directory = fs.mkdtempSync(path.join(tmpdir(), "public-transcript-"));
});
afterEach(() => {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
});
function session(): PersistedSession {
  return {
    id: "session-1",
    name: "Transcript",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    hasUnread: false,
    isActive: false,
    messages: Array.from({ length: 155 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant",
      content: `Public ${index}`,
      timestamp: "2026-01-01T00:00:00Z",
    })),
  };
}

it("lazily decrypts chunks and reassembles a bounded UTF-8 public JSONL transcript without writes", async () => {
  const store = new LocalSessionStore();
  const data = session();
  data.messages[0].content = "🙂עברית".repeat(9000);
  data.messages[0].reasoning = { text: "HIDDEN-REASONING", durationSeconds: null };
  data.messages[1].toolCalls = [
    {
      id: "tool-1",
      name: "Read",
      description: "read result",
      input: "file.ts",
      output: "actual tool output",
      success: true,
    },
  ];
  data.messages[1].contentBlocks = [
    { id: "private", type: "reasoning", text: "BLOCK-REASONING", durationSeconds: null },
    { id: "public", type: "text", content: "Public block" },
  ];
  data.messages[2].role = "user";
  data.messages[2].goalContinuation = true;
  data.messages[2].content = "DELIVERED-CONTROL";
  data.messages[2].internalControl = {
    kind: "goal-continuation",
    exchangeId: "wake-1",
    side: "request",
  };
  data.messages[3].suppressedAgentStatusResponse = true;
  data.messages[3].content = "SUPPRESSED-PUBLIC-REPLY";
  store.saveSessionData(data);
  const uri = path.join(store.sessionsDir, "session-1.json");
  const ciphertext = fs.readFileSync(uri);
  vi.mocked(readEncryptedFileReadOnly).mockClear();
  vi.mocked(writeEncryptedFile).mockClear();
  vi.mocked(writeEncryptedFileSync).mockClear();
  const fullLoad = vi.spyOn(store, "loadSessionData");
  let page = await readRuntimeTranscript(store, { sessionId: data.id, uri });
  expect(page.truncated).toBe(true);
  expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(65536);
  expect(
    vi.mocked(readEncryptedFileReadOnly).mock.calls.filter(([file]) => file.includes(".chunks")),
  ).toHaveLength(1);
  let text = page.text;
  while (page.nextOffset !== undefined) {
    const offset = Buffer.byteLength(text);
    expect(page.nextOffset).toBe(offset);
    // eslint-disable-next-line no-await-in-loop -- each byte offset is returned by the preceding page
    page = await readRuntimeTranscript(store, { sessionId: data.id, uri, offset });
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(65536);
    text += page.text;
  }
  expect(text).not.toContain("�");
  expect(text).not.toMatch(/HIDDEN-REASONING|BLOCK-REASONING/);
  expect(text).toContain("actual tool output");
  expect(text).toContain("DELIVERED-CONTROL");
  expect(text).toContain('"goalContinuation":true');
  expect(text).toContain(
    '"internalControl":{"kind":"goal-continuation","exchangeId":"wake-1","side":"request"}',
  );
  expect(text).toContain("SUPPRESSED-PUBLIC-REPLY");
  expect(text).toContain('"suppressedAgentStatusResponse":true');
  expect(text).toContain('"input":"file.ts"');
  const lines = text.trimEnd().split("\n");
  expect(lines).toHaveLength(155);
  expect(lines[0]).toContain(JSON.stringify(data.messages[0].content));
  expect(lines.at(-1)).toContain('"id":"message-154"');
  expect(fullLoad).not.toHaveBeenCalled();
  expect(writeEncryptedFile).not.toHaveBeenCalled();
  expect(writeEncryptedFileSync).not.toHaveBeenCalled();
  expect(fs.readFileSync(uri)).toEqual(ciphertext);
  await expect(
    readRuntimeTranscript(store, { sessionId: data.id, uri, offset: Buffer.byteLength(text) }),
  ).resolves.toEqual({ uri, text: "", truncated: false });
});

it("reads legacy encrypted blobs without migrating or creating plaintext files", async () => {
  const store = new LocalSessionStore();
  const data = session();
  const uri = path.join(store.sessionsDir, `${data.id}.json`);
  writeEncryptedFileSync(uri, JSON.stringify(data));
  const before = fs.readFileSync(uri);
  vi.mocked(writeEncryptedFileSync).mockClear();
  vi.mocked(writeEncryptedFile).mockClear();
  const page = await readRuntimeTranscript(store, { sessionId: data.id, uri });
  expect(page.text).toContain('"id":"message-154"');
  expect(page.truncated).toBe(false);
  expect(fs.readFileSync(uri)).toEqual(before);
  expect(fs.readdirSync(store.sessionsDir)).toEqual([`${data.id}.json`]);
  expect(writeEncryptedFileSync).not.toHaveBeenCalled();
  expect(writeEncryptedFile).not.toHaveBeenCalled();
});

it("rejects unsafe references and invalid byte offsets before unrelated reads", async () => {
  const store = new LocalSessionStore();
  const data = session();
  data.messages = [{ id: "utf8", role: "user", content: "🙂", timestamp: "now" }];
  store.saveSessionData(data);
  const uri = path.join(store.sessionsDir, `${data.id}.json`);
  vi.mocked(readEncryptedFileReadOnly).mockClear();
  await expect(readRuntimeTranscript(store, { sessionId: "../session-1", uri })).rejects.toThrow(
    "session ID",
  );
  await expect(
    readRuntimeTranscript(store, {
      sessionId: data.id,
      uri: path.join(store.sessionsDir, "other.json"),
    }),
  ).rejects.toThrow("reference");
  await expect(
    readRuntimeTranscript(store, { sessionId: data.id, uri, offset: -1 }),
  ).rejects.toThrow("offset");
  await expect(
    readRuntimeTranscript(store, { sessionId: data.id, uri, offset: 0.5 }),
  ).rejects.toThrow("offset");
  expect(readEncryptedFileReadOnly).not.toHaveBeenCalled();
  const page = await readRuntimeTranscript(store, { sessionId: data.id, uri });
  const split = Buffer.from(page.text).indexOf(Buffer.from("🙂")) + 1;
  await expect(
    readRuntimeTranscript(store, { sessionId: data.id, uri, offset: split }),
  ).rejects.toThrow("UTF-8");
  await expect(
    readRuntimeTranscript(store, { sessionId: data.id, uri, offset: 100000 }),
  ).rejects.toThrow("exceeds");
});
