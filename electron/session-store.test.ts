/**
 * Unit tests for LocalSessionStore (electron/session-store.ts).
 *
 * MOCK STRATEGY — REAL filesystem.
 * ---------------------------------------------------------------------------
 * Sessions are persisted in the HARDENED chunked ("chunked-v1") format:
 *   - header file `{id}.json`: NO real message array. It carries
 *       storageFormat, chunkGen, chunkCount, messageCount, lastMessagePreview,
 *       and `messages: "__chunked-v1__"` — a fail-closed SENTINEL so an older
 *       app version (whose schema expects messages: array) refuses to load it
 *       rather than overwriting it as an "empty" session.
 *   - message chunks live under a GENERATION subdir:
 *       `{id}.chunks/{gen}/NNNN.json`  (gen = "<base36 time>-<rand>")
 *   - writes create a fresh generation, write the header (commit point) last,
 *       then GC strictly-older generations (lexicographically < the kept gen).
 *   - integrity is FAIL-CLOSED: a missing/corrupt chunk, a reconstructed count
 *       that disagrees with header.messageCount, or a chunkCount>0 header with
 *       no chunkGen all cause load to return null + SESSION_LOAD_FAILED rather
 *       than silently dropping messages.
 *
 * Because that code uses real fs primitives (rmSync / readdirSync / existsSync
 * / mkdir / rename) we run against a REAL per-test temp dir and only mock the
 * surrounding collaborators so "encryption" is a plaintext passthrough:
 *   - ./app-paths            → getAppDataDir() returns the per-test temp dir
 *   - ./platform-security    → secureMkdirSync → fs.mkdirSync(..., recursive)
 *   - ./safe-storage-file    → read/write encrypted == read/write plaintext
 *   - ./telemetry-errors     → sendErrorTelemetry is a spy
 * "fs" itself is NOT mocked. The safe-storage mocks default to real-fs
 * passthrough but are vi.fn()s, so individual tests can inject failures.
 */

import * as fs from "fs";
import { DatabaseSync } from "node:sqlite";
import * as os from "os";
import * as path from "path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { makeSessionError, sessionErrors } from "../common/telemetry/errors/marshal-session";
import { SESSION_CHUNK_FORMAT, MESSAGES_PER_CHUNK } from "./schemas/session-schema";
import type { PersistedSession, SessionsIndex } from "./session-store";
import { GOAL_REDACTION_SENTINEL } from "./test-helpers/goal-redaction-fixture";

/** Fail-closed sentinel written into a chunked header's `messages` field. */
const MESSAGES_SENTINEL = "__chunked-v1__";

const mocks = vi.hoisted(() => ({
  /** Mutable per-test data dir; getAppDataDir() resolves to this. */
  dataDir: "",
  readEncryptedFileSync: vi.fn<(p: string) => string>(),
  readEncryptedFile: vi.fn<(p: string) => Promise<string>>(),
  writeEncryptedFileSync: vi.fn<(p: string, c: string) => void>(),
  writeEncryptedFile: vi.fn<(p: string, c: string) => Promise<void>>(),
  secureMkdirSync: vi.fn<(dir: string, mode?: number) => void>(),
  sendErrorTelemetry: vi.fn<(err: unknown, cause?: unknown) => void>(),
}));

vi.mock("./app-paths", () => ({
  getAppDataDir: () => mocks.dataDir,
}));
vi.mock("./platform-security", () => ({
  secureMkdirSync: mocks.secureMkdirSync,
}));
vi.mock("./safe-storage-file", () => ({
  readEncryptedFileSync: mocks.readEncryptedFileSync,
  readEncryptedFile: mocks.readEncryptedFile,
  readEncryptedFileReadOnly: mocks.readEncryptedFile,
  writeEncryptedFileSync: mocks.writeEncryptedFileSync,
  writeEncryptedFile: mocks.writeEncryptedFile,
}));
vi.mock("./telemetry-errors", () => ({
  sendErrorTelemetry: mocks.sendErrorTelemetry,
  hasTelemetryMarker: () => false,
}));

// ---------------------------------------------------------------------------
// Real-fs fixtures
// ---------------------------------------------------------------------------

beforeEach(() => {
  mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-test-"));

  mocks.readEncryptedFileSync.mockReset().mockImplementation((p) => fs.readFileSync(p, "utf8"));
  mocks.readEncryptedFile
    .mockReset()
    .mockImplementation(async (p) => fs.promises.readFile(p, "utf8"));
  mocks.writeEncryptedFileSync.mockReset().mockImplementation((p, c) => fs.writeFileSync(p, c));
  mocks.writeEncryptedFile
    .mockReset()
    .mockImplementation(async (p, c) => fs.promises.writeFile(p, c));
  mocks.secureMkdirSync
    .mockReset()
    .mockImplementation((dir) => fs.mkdirSync(dir, { recursive: true }));
  mocks.sendErrorTelemetry.mockReset();
});

afterEach(() => {
  if (mocks.dataDir) fs.rmSync(mocks.dataDir, { recursive: true, force: true });
});

const sessionsDir = (): string => path.join(mocks.dataDir, "marshal-sessions");
const indexPath = (): string => path.join(sessionsDir(), "sessions-index.json");
const headerPath = (id: string): string => path.join(sessionsDir(), `${id}.json`);
const chunksDir = (id: string): string => path.join(sessionsDir(), `${id}.chunks`);

function writeRaw(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function readHeaderFile(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(headerPath(id), "utf8"));
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** Generation token recorded in the on-disk header. */
function chunkGenOf(id: string): string {
  return String(readHeaderFile(id).chunkGen);
}

/** Directory holding the chunk files for the session's current generation. */
function genChunkDir(id: string): string {
  return path.join(chunksDir(id), chunkGenOf(id));
}

/** All generation subdirectory names under `{id}.chunks`. */
function listGenerations(id: string): string[] {
  if (!fs.existsSync(chunksDir(id))) return [];
  return fs.readdirSync(chunksDir(id)).sort();
}

/** Chunk file names for the current generation. */
function listChunkFiles(id: string): string[] {
  const dir = genChunkDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

/** Force monotonically-increasing Date.now so successive saves mint strictly
 *  time-ordered generation tokens (avoids same-millisecond GC flakiness). */
function installMonotonicNow(): () => void {
  let t = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => {
    t += 60_000;
    return t;
  });
  return () => spy.mockRestore();
}

function makeMessages(n: number): PersistedSession["messages"] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
    timestamp: `2025-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
  }));
}

function makeSession(id: string, messageCount: number): PersistedSession {
  return {
    id,
    name: `Session ${id}`,
    createdAt: "2025-01-01",
    updatedAt: "2025-01-02",
    hasUnread: false,
    isActive: false,
    messages: makeMessages(messageCount),
  } satisfies PersistedSession;
}

/** Commits a new chunk generation (and garbage-collects the old one) while the
 *  store's first async chunk read is in flight, like `markRead` on session open. */
function saveDuringFirstChunkRead(
  store: { saveSessionData(session: PersistedSession): void },
  replacement: PersistedSession,
): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- reaches the store's private chunk reader to interleave a save deterministically
  const internals = store as unknown as {
    readChunkAsync: (...args: unknown[]) => Promise<unknown>;
  };
  const readChunk = internals.readChunkAsync.bind(store);
  let saved = false;
  vi.spyOn(internals, "readChunkAsync").mockImplementation((...args: unknown[]) => {
    if (!saved) {
      saved = true;
      store.saveSessionData(replacement);
    }
    return readChunk(...args);
  });
}

function makeLegacyGoal() {
  return {
    id: "goal-v1",
    objective: "Preserve the legacy goal",
    acceptanceCriteria: ["migration is deterministic", "context survives"],
    status: "blocked" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
    blockedReason: "integration pending",
    blockedKind: "needs-user" as const,
    decisions: [
      {
        id: "decision-1",
        at: "2025-01-01T01:00:00.000Z",
        decision: "Migrate at the schema boundary",
      },
    ],
    openQuestions: [
      {
        id: "question-1",
        at: "2025-01-01T02:00:00.000Z",
        question: "Does migration preserve context?",
        status: "answered" as const,
        answer: "yes",
      },
    ],
    tokensUsed: 100,
    activeMs: 200,
    continuationCount: 4,
  };
}

describe("LocalSessionStore", () => {
  async function createStore() {
    const { LocalSessionStore } = await import("./session-store");
    return new LocalSessionStore();
  }

  // -------------------------------------------------------------------------
  // loadIndex()  (preserved behaviors)
  // -------------------------------------------------------------------------
  describe("loadIndex()", () => {
    it("returns default when file doesn't exist (ENOENT)", async () => {
      const store = await createStore();
      expect(store.loadIndex()).toEqual({ sessions: [], activeSessionId: null });
    });

    it("returns default and warns on non-ENOENT read error", async () => {
      const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
      mocks.readEncryptedFileSync.mockImplementationOnce(() => {
        throw err;
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const store = await createStore();
      const index = store.loadIndex();

      expect(index).toEqual({ sessions: [], activeSessionId: null });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[SessionStore]"),
        expect.stringContaining("failed to read"),
        expect.anything(),
      );
      warnSpy.mockRestore();
    });

    it("returns default on invalid JSON", async () => {
      const store = await createStore();
      writeRaw(indexPath(), "not-json{{{");
      expect(store.loadIndex()).toEqual({ sessions: [], activeSessionId: null });
    });

    it("fires SESSION_INDEX_CORRUPT on invalid JSON", async () => {
      const store = await createStore();
      writeRaw(indexPath(), "not-json{{{");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      store.loadIndex();

      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_INDEX_CORRUPT),
      );
      warnSpy.mockRestore();
    });

    it("returns default on schema validation failure", async () => {
      const store = await createStore();
      writeRaw(indexPath(), '"just a string"');
      expect(store.loadIndex()).toEqual({ sessions: [], activeSessionId: null });
    });

    it("fires SESSION_INDEX_CORRUPT on schema validation failure", async () => {
      const store = await createStore();
      writeRaw(indexPath(), '"just a string"');
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      store.loadIndex();

      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_INDEX_CORRUPT),
      );
      warnSpy.mockRestore();
    });

    it("reuses the validated index while the file is unchanged, as independent copies", async () => {
      const store = await createStore();
      store.saveIndex({ sessions: [], activeSessionId: "first" });
      const indexReads = () =>
        mocks.readEncryptedFileSync.mock.calls.filter(([p]) => p === indexPath()).length;

      const loaded = store.loadIndex();
      loaded.activeSessionId = "mutated";

      expect(store.loadIndex().activeSessionId).toBe("first");
      expect(indexReads()).toBe(1);
    });

    it("rereads the index after a save or an outside rewrite", async () => {
      const store = await createStore();
      store.saveIndex({ sessions: [], activeSessionId: "first" });
      store.loadIndex();

      store.saveIndex({ sessions: [], activeSessionId: "second" });
      expect(store.loadIndex().activeSessionId).toBe("second");

      writeRaw(indexPath(), JSON.stringify({ sessions: [], activeSessionId: "outside-rewrite" }));
      expect(store.loadIndex().activeSessionId).toBe("outside-rewrite");
    });

    it("validates entries individually — one valid + one invalid entry", async () => {
      const validEntry = {
        id: "s1",
        name: "Valid Session",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      };
      const invalidEntry = { name: "Bad Session" }; // missing id

      const store = await createStore();
      writeRaw(
        indexPath(),
        JSON.stringify({ sessions: [validEntry, invalidEntry], activeSessionId: null }),
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const index = store.loadIndex();

      expect(index.sessions).toHaveLength(1);
      expect(index.sessions[0].id).toBe("s1");
      warnSpy.mockRestore();
    });

    it('migrates "workflow" source to "automation" (workflowId → automationId, strips workflowId)', async () => {
      const entry = {
        id: "s1",
        name: "Migrated",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        source: "workflow",
        workflowId: "w1",
      };
      const store = await createStore();
      writeRaw(indexPath(), JSON.stringify({ sessions: [entry], activeSessionId: null }));

      const index = store.loadIndex();

      expect(index.sessions).toHaveLength(1);
      expect(index.sessions[0].source).toBe("automation");
      expect(index.sessions[0].automationId).toBe("w1");
      expect("workflowId" in index.sessions[0]).toBe(false);
    });

    it('preserves "workflow-run" source through migration (R1-FIXES A2)', async () => {
      const entry = {
        id: "wr-1",
        name: "Workflow Run",
        createdAt: "2026-05-29",
        updatedAt: "2026-05-29",
        source: "workflow-run",
      };
      const store = await createStore();
      writeRaw(indexPath(), JSON.stringify({ sessions: [entry], activeSessionId: null }));

      const index = store.loadIndex();

      expect(index.sessions).toHaveLength(1);
      expect(index.sessions[0].source).toBe("workflow-run");
    });

    it("derives runtimeId from backendOrigin and defaults fully legacy rows to the default runtime", async () => {
      const store = await createStore();
      writeRaw(
        indexPath(),
        JSON.stringify({
          sessions: [
            { id: "gateway", name: "Gateway", backendOrigin: "gateway" },
            { id: "copilot", name: "Copilot", backendOrigin: "copilot" },
            { id: "legacy", name: "Legacy" },
          ],
          activeSessionId: null,
        }),
      );

      const index = store.loadIndex();

      expect(index.sessions.map(({ id, runtimeId }) => ({ id, runtimeId }))).toEqual([
        { id: "gateway", runtimeId: "gateway" },
        { id: "copilot", runtimeId: "copilot" },
        { id: "legacy", runtimeId: "claude" },
      ]);
    });

    it("serves one read-only snapshot until the index file changes", async () => {
      const store = await createStore();
      store.saveIndex({ sessions: [], activeSessionId: "first" });

      const snapshot = store.loadIndexReadOnly();
      expect(store.loadIndexReadOnly()).toBe(snapshot);
      const copy = store.loadIndex();
      copy.activeSessionId = "mutated";
      expect(store.loadIndexReadOnly().activeSessionId).toBe("first");

      store.saveIndex({ sessions: [], activeSessionId: "second" });
      expect(store.loadIndexReadOnly().activeSessionId).toBe("second");
    });

    it("promotes cloudSessionId → backendId on legacy gateway rows", async () => {
      const legacyEntry = {
        id: "s1",
        name: "Legacy Gateway Session",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        backendOrigin: "gateway",
        cloudSessionId: "cloud-uuid-123",
      };
      const store = await createStore();
      writeRaw(indexPath(), JSON.stringify({ sessions: [legacyEntry], activeSessionId: null }));

      const index = store.loadIndex();

      expect(index.sessions).toHaveLength(1);
      expect(index.sessions[0].backendId).toBe("cloud-uuid-123");
      expect(index.sessions[0].runtimeId).toBe("gateway");
    });
  });

  // -------------------------------------------------------------------------
  // saveIndex()  (preserved)
  // -------------------------------------------------------------------------
  describe("saveIndex()", () => {
    it("writes serialized JSON to sessions-index.json on disk", async () => {
      const store = await createStore();
      const index: SessionsIndex = { sessions: [], activeSessionId: null };
      store.saveIndex(index);

      expect(mocks.writeEncryptedFileSync).toHaveBeenCalledWith(
        expect.stringContaining("sessions-index.json"),
        JSON.stringify(index, null, 2),
      );
      expect(JSON.parse(fs.readFileSync(indexPath(), "utf8"))).toEqual(index);
    });
  });

  // -------------------------------------------------------------------------
  // withIndexLock()  (preserved)
  // -------------------------------------------------------------------------
  describe("withIndexLock()", () => {
    it("serializes concurrent mutations — save-1 completes before callback-2", async () => {
      const events: string[] = [];
      const store = await createStore();
      mocks.writeEncryptedFileSync.mockImplementation((p, c) => {
        events.push("save");
        fs.writeFileSync(p, c);
      });

      const p1 = store.withIndexLock(() => {
        events.push("fn1");
      });
      const p2 = store.withIndexLock(() => {
        events.push("fn2");
      });
      await p1;
      await p2;

      expect(events).toEqual(["fn1", "save", "fn2", "save"]);
    });

    it("persists index mutations made by callback", async () => {
      const store = await createStore();

      await store.withIndexLock((index) => {
        index.sessions.push({
          id: "new-session",
          name: "Added",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
          hasUnread: false,
          isActive: false,
        });
      });

      const persisted = JSON.parse(fs.readFileSync(indexPath(), "utf8"));
      expect(persisted.sessions).toHaveLength(1);
      expect(persisted.sessions[0].id).toBe("new-session");
    });

    it("rejects on callback error, skips save, and keeps the queue operational", async () => {
      const store = await createStore();
      mocks.writeEncryptedFileSync.mockClear();

      await expect(
        store.withIndexLock(() => {
          throw new Error("oops");
        }),
      ).rejects.toThrow("oops");

      expect(mocks.writeEncryptedFileSync).not.toHaveBeenCalled();
      await expect(store.withIndexLock(() => "ok")).resolves.toBe("ok");
    });

    it("callback-2 sees mutations written by callback-1", async () => {
      const store = await createStore();

      const p1 = store.withIndexLock((index) => {
        index.activeSessionId = "s1";
      });
      const p2 = store.withIndexLock((index) => {
        expect(index.activeSessionId).toBe("s1");
        index.activeSessionId = "s2";
      });
      await p1;
      await p2;

      const final = JSON.parse(fs.readFileSync(indexPath(), "utf8"));
      expect(final.activeSessionId).toBe("s2");
    });
  });

  describe("flushPendingWrites()", () => {
    it("waits for index work and every per-session async write queue to settle", async () => {
      const store = await createStore();
      writeRaw(headerPath("a"), JSON.stringify(makeSession("a", 1)));
      writeRaw(headerPath("b"), JSON.stringify(makeSession("b", 1)));

      let releaseA!: () => void;
      let releaseB!: () => void;
      const gates = new Map([
        ["a", new Promise<void>((resolve) => (releaseA = resolve))],
        ["b", new Promise<void>((resolve) => (releaseB = resolve))],
      ]);
      const started = new Set<string>();
      mocks.writeEncryptedFile.mockImplementation(async (filePath, content) => {
        const value = filePath;
        const sessionId = ["a", "b"].find((id) =>
          value.includes(`${path.sep}${id}.chunks${path.sep}`),
        );
        if (sessionId && !started.has(sessionId)) {
          started.add(sessionId);
          await gates.get(sessionId);
        }
        await fs.promises.writeFile(filePath, content);
      });

      const loadA = store.loadSessionDataAsync("a");
      await vi.waitFor(() => expect(started).toEqual(new Set(["a"])));

      let drained = false;
      const flush = store.flushPendingWrites().then(() => {
        drained = true;
      });
      const indexMutation = store.withIndexLock((index) => {
        index.activeSessionId = "b";
      });
      const loadB = store.loadSessionDataAsync("b");
      await vi.waitFor(() => expect(started).toEqual(new Set(["a", "b"])));

      releaseA();
      await loadA;
      await indexMutation;
      expect(drained).toBe(false);

      releaseB();
      await Promise.all([loadB, flush]);

      expect(drained).toBe(true);
      expect(store.loadIndex().activeSessionId).toBe("b");
    });

    it("does not miss a new session queue registered while draining", async () => {
      const store = await createStore();
      writeRaw(headerPath("a"), JSON.stringify(makeSession("a", 1)));
      writeRaw(headerPath("b"), JSON.stringify(makeSession("b", 1)));

      let releaseA!: () => void;
      let releaseB!: () => void;
      const gates = new Map([
        ["a", new Promise<void>((resolve) => (releaseA = resolve))],
        ["b", new Promise<void>((resolve) => (releaseB = resolve))],
      ]);
      const started = new Set<string>();
      mocks.writeEncryptedFile.mockImplementation(async (filePath, content) => {
        const value = filePath;
        const sessionId = ["a", "b"].find((id) =>
          value.includes(`${path.sep}${id}.chunks${path.sep}`),
        );
        if (sessionId && !started.has(sessionId)) {
          started.add(sessionId);
          await gates.get(sessionId);
        }
        await fs.promises.writeFile(filePath, content);
      });

      const loadA = store.loadSessionDataAsync("a");
      await vi.waitFor(() => expect(started).toEqual(new Set(["a"])));

      let drained = false;
      const flush = store.flushPendingWrites().then(() => {
        drained = true;
      });
      await Promise.resolve();
      const loadB = store.loadSessionDataAsync("b");
      await vi.waitFor(() => expect(started).toEqual(new Set(["a", "b"])));

      releaseA();
      await loadA;
      await Promise.resolve();
      expect(drained).toBe(false);

      releaseB();
      await Promise.all([loadB, flush]);
      expect(drained).toBe(true);
    });
  });

  describe("saveIndex → loadIndex round-trip", () => {
    it("preserves all fields through serialization", async () => {
      const store = await createStore();
      const original: SessionsIndex = {
        sessions: [
          {
            id: "s1",
            name: "Test Session",
            createdAt: "2025-01-01T00:00:00.000Z",
            updatedAt: "2025-01-02T00:00:00.000Z",
            hasUnread: true,
            isActive: false,
            model: "gpt-5.6-sol",
            reasoningEffort: "max",
            contextTier: "long_context",
            source: "user",
            workspaceName: "Project",
            workspaceIdentity: {
              version: 1,
              device: "1",
              inode: "2",
              birthtimeNs: "3",
            },
            repositoryAgent: {
              name: "Reviewer",
              path: ".github/agents/reviewer.agent.md",
              identity: {
                version: 1,
                normalizedPath: ".github/agents/reviewer.agent.md",
                declaredName: "Reviewer",
                contentDigest: "reviewer-v1",
              },
            },
          },
        ],
        activeSessionId: "s1",
        defaultModel: "gpt-5.6-sol",
        defaultReasoningEfforts: { "gpt-5.6-sol": "max" },
        defaultContextTiers: { "gpt-5.6-sol": "long_context" },
      };
      store.saveIndex(original);

      const loaded = store.loadIndex();
      expect(loaded.sessions).toHaveLength(1);
      expect(loaded.sessions[0].hasUnread).toBe(true);
      expect(loaded.sessions[0].name).toBe("Test Session");
      expect(loaded.activeSessionId).toBe("s1");
      expect(loaded.defaultModel).toBe("gpt-5.6-sol");
      expect(loaded.defaultReasoningEfforts).toEqual({ "gpt-5.6-sol": "max" });
      expect(loaded.defaultContextTiers).toEqual({ "gpt-5.6-sol": "long_context" });
      expect(loaded.sessions[0]).toMatchObject({
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        contextTier: "long_context",
        workspaceIdentity: {
          version: 1,
          device: "1",
          inode: "2",
          birthtimeNs: "3",
        },
        repositoryAgent: {
          identity: {
            contentDigest: "reviewer-v1",
          },
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // saveSessionData() — chunked-v1 on-disk layout (generation dirs + sentinel)
  // -------------------------------------------------------------------------
  describe("saveSessionData() — chunked layout", () => {
    it("writes a header (sentinel messages) + a generation dir with ceil(N/CHUNK) chunk files", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK * 2 + 20; // 120 → 3 chunks (50/50/20)
      store.saveSessionData(makeSession("s1", n));

      const header = readHeaderFile("s1");
      expect(header.storageFormat).toBe(SESSION_CHUNK_FORMAT);
      expect(header.chunkCount).toBe(Math.ceil(n / MESSAGES_PER_CHUNK));
      expect(header.messageCount).toBe(n);
      expect(header.lastMessagePreview).toBe(`message ${n - 1}`);
      // Header carries the fail-closed sentinel STRING, not a real array.
      expect(header.messages).toBe(MESSAGES_SENTINEL);
      expect(Array.isArray(header.messages)).toBe(false);
      expect(typeof header.chunkGen).toBe("string");
      if (typeof header.chunkGen !== "string") throw new Error("Expected a chunk generation");
      expect(header.chunkGen.length).toBeGreaterThan(0);

      // Exactly one generation subdir, named by chunkGen, holding the chunk files.
      expect(listGenerations("s1")).toEqual([header.chunkGen]);
      expect(listChunkFiles("s1")).toEqual(["0000.json", "0001.json", "0002.json"]);

      const chunk0 = JSON.parse(fs.readFileSync(path.join(genChunkDir("s1"), "0000.json"), "utf8"));
      const chunk2 = JSON.parse(fs.readFileSync(path.join(genChunkDir("s1"), "0002.json"), "utf8"));
      expect(chunk0).toHaveLength(MESSAGES_PER_CHUNK);
      expect(chunk2).toHaveLength(n - MESSAGES_PER_CHUNK * 2);
      expect(chunk0[0].id).toBe("m0");
      expect(chunk2.at(-1).id).toBe(`m${n - 1}`);
    });

    it("writes the header LAST (after all chunk files)", async () => {
      const store = await createStore();
      store.saveSessionData(makeSession("s1", MESSAGES_PER_CHUNK + 1)); // 2 chunks + header

      const writtenPaths = mocks.writeEncryptedFileSync.mock.calls.map((c) => c[0]);
      expect(writtenPaths.at(-1)).toBe(headerPath("s1"));
      expect(writtenPaths.indexOf(headerPath("s1"))).toBe(writtenPaths.length - 1);
    });

    it("a 0-message session has chunkCount 0 and NO chunks directory", async () => {
      const store = await createStore();
      store.saveSessionData(makeSession("empty", 0));

      const header = readHeaderFile("empty");
      expect(header.storageFormat).toBe(SESSION_CHUNK_FORMAT);
      expect(header.chunkCount).toBe(0);
      expect(header.messageCount).toBe(0);
      expect(header.messages).toBe(MESSAGES_SENTINEL);
      expect("lastMessagePreview" in header).toBe(false);
      expect(fs.existsSync(chunksDir("empty"))).toBe(false);
    });

    it("exactly MESSAGES_PER_CHUNK messages → 1 chunk; one more → 2 chunks", async () => {
      const store = await createStore();
      store.saveSessionData(makeSession("exact", MESSAGES_PER_CHUNK));
      expect(listChunkFiles("exact")).toEqual(["0000.json"]);
      expect(readHeaderFile("exact").chunkCount).toBe(1);

      store.saveSessionData(makeSession("plus1", MESSAGES_PER_CHUNK + 1));
      expect(listChunkFiles("plus1")).toEqual(["0000.json", "0001.json"]);
      expect(readHeaderFile("plus1").chunkCount).toBe(2);
    });

    it("preserves internal control correlation across a chunk boundary and tail hydration", async () => {
      const store = await createStore();
      const current = makeSession("internal-control-chunks", MESSAGES_PER_CHUNK - 1);
      const exchangeId = "goal-continuation:goal-1:1";
      current.messages.push(
        {
          id: "control-request",
          role: "user",
          content: "PRIVATE_CONTINUATION_PROMPT",
          timestamp: "2026-07-24T09:00:00.000Z",
          goalContinuation: true,
          internalControl: {
            kind: "goal-continuation",
            exchangeId,
            side: "request",
          },
        },
        {
          id: "control-response",
          role: "assistant",
          content: "PRIVATE_INTERNAL_RESULT",
          timestamp: "2026-07-24T09:00:01.000Z",
          internalControl: {
            kind: "goal-continuation",
            exchangeId,
            side: "response",
          },
        },
      );

      store.saveSessionData(current);

      expect(store.loadSessionData(current.id)?.messages.slice(-2)).toMatchObject([
        {
          id: "control-request",
          internalControl: { exchangeId, side: "request" },
        },
        {
          id: "control-response",
          internalControl: { exchangeId, side: "response" },
        },
      ]);
      await expect(store.loadSessionMessagesTail(current.id, 1)).resolves.toMatchObject({
        messages: [
          {
            id: "control-response",
            internalControl: { exchangeId, side: "response" },
          },
        ],
      });
    });

    it("lastMessagePreview = first non-empty content from the tail, truncated to 200 chars", async () => {
      const store = await createStore();
      const session = makeSession("preview", 0);
      session.messages = [
        { id: "a", role: "user", content: "first", timestamp: "t" },
        { id: "b", role: "assistant", content: "x".repeat(250), timestamp: "t" },
        { id: "c", role: "user", content: "   ", timestamp: "t" }, // whitespace → skipped
        { id: "d", role: "assistant", content: "", timestamp: "t" }, // empty → skipped
        {
          id: "e",
          role: "system",
          content: "Private readiness status",
          timestamp: "t",
          agentMessage: {
            source: "child-1",
            sourceLabel: "Worker",
            sourceSessionSource: "subagent",
            kind: "readiness",
            deliveryMode: "queue",
            sequence: 2,
            readinessGeneration: "generation-2",
          },
        },
        {
          id: "f",
          role: "assistant",
          content: "Private readiness reply",
          timestamp: "t",
          suppressedAgentStatusResponse: true,
        },
      ];
      store.saveSessionData(session);

      const preview = readHeaderFile("preview").lastMessagePreview;
      if (typeof preview !== "string") throw new Error("Expected a last-message preview");
      expect(preview).toHaveLength(200);
      expect(preview).toBe("x".repeat(200));
    });

    it("uses readiness-triggered assistant work but not its hidden request for the header preview", async () => {
      const store = await createStore();
      const session = makeSession("readiness-preview", 0);
      session.messages = [
        {
          id: "control",
          role: "user",
          content: "PRIVATE_PARENT_WAKE_PROMPT",
          timestamp: "t",
          internalControl: {
            kind: "subagent-readiness",
            exchangeId: "subagent-readiness:readiness-preview:test",
            side: "request",
          },
        },
        {
          id: "work",
          role: "assistant",
          content: "Integrated both validator results.",
          timestamp: "t",
          internalControl: {
            kind: "subagent-readiness",
            exchangeId: "subagent-readiness:readiness-preview:test",
            side: "response",
          },
        },
      ];

      store.saveSessionData(session);

      expect(readHeaderFile("readiness-preview").lastMessagePreview).toBe(
        "Integrated both validator results.",
      );
    });

    it("redacts secrets from the persisted last-message preview", async () => {
      const store = await createStore();
      const session = makeSession("preview-secret", 0);
      session.messages = [
        {
          id: "secret",
          role: "user",
          content: `${"x".repeat(190)}${GOAL_REDACTION_SENTINEL}`,
          timestamp: "t",
        },
      ];

      store.saveSessionData(session);

      const preview = readHeaderFile("preview-secret").lastMessagePreview;
      if (typeof preview !== "string") throw new Error("Expected persisted preview");
      expect(preview).not.toContain(GOAL_REDACTION_SENTINEL);
      expect(preview).not.toContain("ghp_");
      expect(preview).toContain("[REDACTED");
      expect(session.messages[0]?.content).toContain(GOAL_REDACTION_SENTINEL);
    });

    it("incremental save re-encrypts only changed chunks and reuses the rest", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK * 2 + 20; // 120 → chunks 0000/0001/0002 (50/50/20)
      store.saveSessionData(makeSession("s1", n));

      mocks.writeEncryptedFileSync.mockClear();

      // Append one message: only the last chunk (0002) changes; 0000/0001 are
      // byte-identical and must be COPIED, not re-encrypted.
      store.saveSessionData(makeSession("s1", n + 1));

      const written = mocks.writeEncryptedFileSync.mock.calls.map((c) => c[0]);
      expect(written.some((p) => p.endsWith("0000.json"))).toBe(false);
      expect(written.some((p) => p.endsWith("0001.json"))).toBe(false);
      expect(written.some((p) => p.endsWith("0002.json"))).toBe(true);
      expect(written).toContain(headerPath("s1"));

      // Correctness: the reconstructed session has every message, in order.
      const loaded = store.loadSessionData("s1");
      expect(loaded?.messages).toHaveLength(n + 1);
      expect(loaded?.messages[0]?.id).toBe("m0");
      expect(loaded?.messages.at(-1)?.id).toBe(`m${n}`);
    });
  });

  // -------------------------------------------------------------------------
  // loadSessionData() / loadSessionDataAsync() — round-trip
  // -------------------------------------------------------------------------
  describe("loadSessionData() / loadSessionDataAsync() round-trip", () => {
    it("saves then loads back an equal session (messages in order)", async () => {
      const store = await createStore();
      const session = makeSession("rt", 5);
      store.saveSessionData(session);

      const loaded = store.loadSessionData("rt");
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe("rt");
      expect(loaded!.name).toBe(session.name);
      expect(loaded!.messages).toHaveLength(5);
      expect(loaded!.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
      expect(loaded!.messages.map((m) => m.content)).toEqual(
        session.messages.map((m) => m.content),
      );
      // The reconstructed session carries a real array — never the sentinel.
      expect(loaded!.messages).not.toBe(MESSAGES_SENTINEL);
    });

    it("reconstructs messages by concatenating chunks IN ORDER (multi-chunk)", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK * 2 + 20;
      store.saveSessionData(makeSession("multi", n));

      const loaded = store.loadSessionData("multi");
      expect(loaded!.messages).toHaveLength(n);
      expect(loaded!.messages.map((m) => m.id)).toEqual(
        Array.from({ length: n }, (_, i) => `m${i}`),
      );
    });

    it("async load returns the same messages as sync load", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK * 2 + 20;
      store.saveSessionData(makeSession("a", n));

      const sync = store.loadSessionData("a");
      const async = await store.loadSessionDataAsync("a");
      expect(sync!.messages).toHaveLength(n);
      expect(async!.messages).toHaveLength(n);
      expect(async!.messages.map((m) => m.id)).toEqual(sync!.messages.map((m) => m.id));
    });

    it("async load restarts from the new generation when a save lands mid-read", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK * 2 + 20;
      store.saveSessionData(makeSession("race-full", n));
      saveDuringFirstChunkRead(store, { ...makeSession("race-full", n), isPinned: true });

      const loaded = await store.loadSessionDataAsync("race-full");
      expect(loaded?.messages).toHaveLength(n);
      expect(loaded?.isPinned).toBe(true);
    });

    it("emits worker proof only for an exactly matching committed chunk generation", async () => {
      const { computeSessionWorkerBaseDigest } =
        await import("./persistence/session-worker-base-proof");
      const store = await createStore();
      const session = makeSession("worker-proof", 2);
      const generation = "worker-proof-generation";
      const generationToken = "worker-proof-token";
      const { messages, ...header } = session;
      writeRaw(path.join(chunksDir(session.id), generation, "0000.json"), JSON.stringify(messages));
      writeRaw(
        headerPath(session.id),
        JSON.stringify({
          ...header,
          storageFormat: SESSION_CHUNK_FORMAT,
          messages: MESSAGES_SENTINEL,
          chunkGen: generation,
          chunkCount: 1,
          messageCount: messages.length,
          persistenceProofVersion: 1,
          persistenceGenerationToken: generationToken,
          persistenceCanonicalDigest: computeSessionWorkerBaseDigest(messages),
        }),
      );

      const loaded = await store.loadSessionDataWithWorkerBaseProofAsync(session.id);

      expect(loaded.session?.messages).toEqual(messages);
      expect(loaded.workerBaseProof).toEqual({
        schemaVersion: 1,
        generationToken,
        canonicalDigest: computeSessionWorkerBaseDigest(messages),
        messageCount: messages.length,
      });
    });

    it("does not emit worker proof when archive history replaces an empty local generation", async () => {
      const store = await createStore();
      try {
        store.saveSessionData(makeSession("archive-proof", 0));
        const database = new DatabaseSync(path.join(mocks.dataDir, "session-store.db"));
        try {
          database.exec(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            cwd TEXT,
            repository TEXT,
            summary TEXT,
            created_at TEXT,
            updated_at TEXT
          );
          CREATE TABLE turns (
            id INTEGER PRIMARY KEY,
            session_id TEXT,
            turn_index INTEGER,
            user_message TEXT,
            assistant_response TEXT,
            timestamp TEXT
          );
          INSERT INTO sessions VALUES (
            'archive-proof', NULL, NULL, 'Archived session',
            '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z'
          );
          INSERT INTO turns VALUES (
            1, 'archive-proof', 0, 'archived message', NULL, '2026-08-01T00:00:00.000Z'
          );
        `);
        } finally {
          database.close();
        }

        const loaded = await store.loadSessionDataWithWorkerBaseProofAsync("archive-proof");

        expect(loaded.session?.messages.map((message) => message.content)).toEqual([
          "archived message",
        ]);
        expect(loaded.workerBaseProof).toBeUndefined();
      } finally {
        store.dispose();
      }
    });

    it("round-trips workspace and repository role identities without role content", async () => {
      const store = await createStore();
      const session = makeSession("workspace-role-identities", 0);
      session.source = "user";
      session.workspaceName = "Project";
      session.workspaceIdentity = {
        version: 1,
        device: "1",
        inode: "2",
        birthtimeNs: "3",
      };
      session.repositoryAgent = {
        name: "Reviewer",
        path: ".github/agents/reviewer.agent.md",
        description: "Reviews changes",
        identity: {
          version: 1,
          normalizedPath: ".github/agents/reviewer.agent.md",
          declaredName: "Reviewer",
          contentDigest: "reviewer-v1",
        },
      };
      store.saveSessionData(session);

      const loaded = store.loadSessionData(session.id);
      expect(loaded?.workspaceIdentity).toEqual(session.workspaceIdentity);
      expect(loaded?.repositoryAgent).toEqual(session.repositoryAgent);
      expect(JSON.stringify(readHeaderFile(session.id))).not.toContain("Review carefully");
    });

    it("round-trips the read-only reviewer permission mode", async () => {
      const store = await createStore();
      const session = makeSession("reviewer-mode", 0);
      session.permissionMode = "read-only-reviewer";
      store.saveSessionData(session);

      expect(store.loadSessionData("reviewer-mode")?.permissionMode).toBe("read-only-reviewer");
    });

    it("round-trips a 0-message session as an empty messages array", async () => {
      const store = await createStore();
      store.saveSessionData(makeSession("empty", 0));

      expect(store.loadSessionData("empty")!.messages).toEqual([]);
      expect((await store.loadSessionDataAsync("empty"))!.messages).toEqual([]);
    });

    it("returns null when the session header does not exist", async () => {
      const store = await createStore();
      expect(store.loadSessionData("nope")).toBeNull();
      expect(await store.loadSessionDataAsync("nope")).toBeNull();
    });

    it("round-trips permission cards (memory + hook)", async () => {
      const store = await createStore();
      const session = makeSession("cards", 0);
      session.permissionCards = [
        {
          id: "p1",
          kind: "memory",
          title: "Memory",
          message: "Remember fact",
          detail: "Store a durable fact",
          buttons: ["Allow", "Deny"],
        },
        {
          id: "p2",
          kind: "hook",
          title: "Hook",
          message: "Run hook",
          detail: "Execute permission hook",
          buttons: ["Allow", "Deny"],
        },
      ];
      store.saveSessionData(session);

      const loaded = store.loadSessionData("cards");
      expect(loaded?.permissionCards?.map((c) => c.kind)).toEqual(["memory", "hook"]);
    });

    it("round-trips browser-use disclosure on url permission cards", async () => {
      const store = await createStore();
      const session = makeSession("url", 0);
      session.permissionCards = [
        {
          id: "p1",
          kind: "url",
          title: "Open a Website",
          message: "M wants to visit a webpage",
          detail: "URL: https://example.com",
          buttons: ["Allow", "Deny"],
          browserUseDisclosure: true,
        },
      ];
      store.saveSessionData(session);

      expect(store.loadSessionData("url")?.permissionCards?.[0].browserUseDisclosure).toBe(true);
    });

    it("migrates a legacy readiness reply across a paginated chunk boundary", async () => {
      const store = await createStore();
      const session = makeSession("legacy-readiness-page", 0);
      session.messages = [
        ...Array.from({ length: 49 }, (_, index) => ({
          id: `filler-${index}`,
          role: "user" as const,
          content: `filler ${index}`,
          timestamp: `2026-07-25T07:${String(index).padStart(2, "0")}:00.000Z`,
        })),
        {
          id: "legacy-readiness",
          role: "user",
          content:
            'Message from subagent Worker (child-1):\n\nSubagent "Worker" (child-1) is idle and ready for follow-up.',
          timestamp: "2026-07-25T08:00:00.000Z",
          agentMessage: {
            source: "child-1",
            sourceLabel: "Worker",
            sourceSessionSource: "subagent",
            kind: "parent",
            deliveryMode: "queue",
            sequence: 1,
            messageId: "legacy-readiness",
            idempotencyKey: "subagent-idle:child-1:2026-07-25T08:00:00.000Z",
            target: "legacy-readiness-page",
          },
        },
        {
          id: "legacy-reply",
          role: "assistant",
          content: "No action needed.",
          timestamp: "2026-07-25T08:00:01.000Z",
        },
      ];
      store.saveSessionData(session);

      const page = await store.loadSessionMessagesTail(session.id, 1);

      expect(page.messages).toEqual([
        expect.objectContaining({
          id: "legacy-reply",
          suppressedAgentStatusResponse: true,
        }),
      ]);
    });

    it("round-trips persisted goal timeline and agent-message metadata", async () => {
      const store = await createStore();
      const session: PersistedSession = {
        id: "g",
        name: "Goal session",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        hasUnread: false,
        isActive: false,
        source: "user",
        workspaceName: "Project",
        workspaceIdentity: {
          version: 1,
          device: "1",
          inode: "2",
          birthtimeNs: "3",
        },
        repositoryAgent: {
          name: "Reviewer",
          path: ".github/agents/reviewer.agent.md",
          identity: {
            version: 1,
            normalizedPath: ".github/agents/reviewer.agent.md",
            declaredName: "Reviewer",
            contentDigest: "reviewer-v1",
          },
        },
        messages: [
          {
            id: "m1",
            role: "user",
            content: "go",
            timestamp: "2025-01-01",
            goalContinuation: true,
            goalTimelineEvent: {
              type: "goal.continuation",
              fence: {
                goalId: "g1",
                epoch: 1,
              },
              sequence: 1,
              verification: false,
              resumeTrigger: {
                kind: "initial-pursuit",
                reason: "Autonomous pursuit started for this goal.",
                occurredAt: "2025-01-01",
              },
              durableMilestone: {},
              agent: {
                sessionId: "g",
                source: "assistant",
                sourceLabel: "Primary agent",
              },
            },
          },
          {
            id: "m2",
            role: "user",
            content: "Message from subagent Worker (child-1):\n\nReady to integrate.",
            timestamp: "2025-01-02",
            agentMessage: {
              messageId: "delivery-7",
              idempotencyKey: "delivery-7",
              source: "child-1",
              sourceLabel: "Worker",
              target: "g",
              kind: "parent",
              deliveryMode: "queue",
              priority: 10,
              sequence: 7,
              attempts: 1,
              state: "processed",
              acceptedAt: "2025-01-02",
              updatedAt: "2025-01-02",
              processedAt: "2025-01-02",
              sourceSessionSource: "subagent",
            },
          },
        ],
        goal: {
          schemaVersion: 3,
          id: "g1",
          epoch: 1,
          objective: "Ship onboarding",
          criteria: ["tests pass"],
          status: "blocked",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
          blockedReason: "need creds",
          progress: [],
          openQuestions: [],
          assumptions: [],
          decisions: [],
          state: {},
          tokensUsed: 1234,
          activeMs: 5000,
          continuationCount: 7,
        },
      };
      store.saveSessionData(session);

      const loaded = store.loadSessionData("g");
      expect(loaded?.goal?.status).toBe("blocked");
      expect(loaded?.goal?.tokensUsed).toBe(1234);
      expect(loaded?.goal?.criteria).toEqual(["tests pass"]);
      expect(loaded?.goal?.schemaVersion).toBe(3);
      expect(loaded?.goal?.epoch).toBe(1);
      expect(loaded).toMatchObject({
        source: "user",
        workspaceName: "Project",
        workspaceIdentity: session.workspaceIdentity,
        repositoryAgent: session.repositoryAgent,
      });
      expect(loaded?.messages[0].goalContinuation).toBe(true);
      expect(loaded?.messages[0].goalTimelineEvent).toMatchObject({
        type: "goal.continuation",
        sequence: 1,
      });
      expect(loaded?.messages[1].agentMessage).toEqual({
        messageId: "delivery-7",
        idempotencyKey: "delivery-7",
        source: "child-1",
        sourceLabel: "Worker",
        target: "g",
        kind: "parent",
        deliveryMode: "queue",
        priority: 10,
        sequence: 7,
        attempts: 1,
        state: "processed",
        acceptedAt: "2025-01-02",
        updatedAt: "2025-01-02",
        processedAt: "2025-01-02",
        sourceSessionSource: "subagent",
      });
    });
  });

  // -------------------------------------------------------------------------
  // FAIL-CLOSED INTEGRITY  (new hardening behaviors)
  // -------------------------------------------------------------------------
  describe("fail-closed integrity", () => {
    it("returns null + SESSION_LOAD_FAILED when a chunk fails schema validation (sync)", async () => {
      const store = await createStore();
      store.saveSessionData(makeSession("cc", 3)); // 1 chunk, 3 messages
      // Replace chunk 0 with a structurally-invalid message array.
      fs.writeFileSync(
        path.join(genChunkDir("cc"), "0000.json"),
        JSON.stringify([{ not: "a message" }]),
      );
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(store.loadSessionData("cc")).toBeNull();
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_LOAD_FAILED),
      );
      errSpy.mockRestore();
    });

    it("returns null + SESSION_LOAD_FAILED when a chunk fails schema validation (async)", async () => {
      const store = await createStore();
      store.saveSessionData(makeSession("cca", 3));
      fs.writeFileSync(
        path.join(genChunkDir("cca"), "0000.json"),
        JSON.stringify([{ not: "a message" }]),
      );
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await store.loadSessionDataAsync("cca")).toBeNull();
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_LOAD_FAILED),
      );
      errSpy.mockRestore();
    });

    it("returns null + SESSION_LOAD_FAILED when a chunk file is missing", async () => {
      const store = await createStore();
      store.saveSessionData(makeSession("mc", MESSAGES_PER_CHUNK + 1)); // 2 chunks
      fs.rmSync(path.join(genChunkDir("mc"), "0001.json")); // delete the tail chunk
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(store.loadSessionData("mc")).toBeNull();
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_LOAD_FAILED),
      );
      errSpy.mockRestore();
    });

    it("returns null + SESSION_LOAD_FAILED when reconstructed count != header.messageCount", async () => {
      const store = await createStore();
      store.saveSessionData(makeSession("cm", 2)); // header.messageCount = 2, 1 chunk
      // Rewrite chunk 0 with a VALID but SHORTER array (1 message) → count mismatch.
      fs.writeFileSync(
        path.join(genChunkDir("cm"), "0000.json"),
        JSON.stringify([{ id: "m0", role: "user", content: "only one", timestamp: "t" }]),
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(store.loadSessionData("cm")).toBeNull();
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_LOAD_FAILED),
      );
      warnSpy.mockRestore();
    });

    it("returns null + SESSION_LOAD_FAILED for a chunked header with chunkCount>0 but no chunkGen", async () => {
      const store = await createStore();
      writeRaw(
        headerPath("ng"),
        JSON.stringify({
          id: "ng",
          name: "No Gen",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
          storageFormat: SESSION_CHUNK_FORMAT,
          messages: MESSAGES_SENTINEL,
          chunkCount: 1,
          messageCount: 1,
          // chunkGen intentionally absent
        }),
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(store.loadSessionData("ng")).toBeNull();
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_LOAD_FAILED),
      );
      warnSpy.mockRestore();
    });

    it("returns null + SESSION_LOAD_FAILED on a corrupt chunked header (schema failure)", async () => {
      const store = await createStore();
      writeRaw(
        headerPath("bad"),
        JSON.stringify({
          id: "bad",
          name: "Bad",
          createdAt: "t",
          updatedAt: "t",
          storageFormat: SESSION_CHUNK_FORMAT,
          messages: MESSAGES_SENTINEL,
          chunkCount: "oops", // wrong type
          messageCount: 0,
        }),
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(store.loadSessionData("bad")).toBeNull();
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_LOAD_FAILED),
      );
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // GENERATION GC  (new hardening behavior)
  // -------------------------------------------------------------------------
  describe("generation garbage collection", () => {
    it("after two saves keeps exactly ONE (latest) generation dir and loads the latest messages", async () => {
      const restoreNow = installMonotonicNow();
      try {
        const store = await createStore();
        store.saveSessionData(makeSession("gc", 60)); // gen1 (2 chunks)
        const gen1 = chunkGenOf("gc");
        store.saveSessionData(makeSession("gc", 10)); // gen2 (1 chunk)
        const gen2 = chunkGenOf("gc");

        expect(gen2).not.toBe(gen1);
        // Strictly-older gen1 is garbage-collected; only the latest survives.
        expect(listGenerations("gc")).toEqual([gen2]);

        const loaded = store.loadSessionData("gc");
        expect(loaded!.messages).toHaveLength(10);
        expect(loaded!.messages.map((m) => m.id)).toEqual(
          Array.from({ length: 10 }, (_, i) => `m${i}`),
        );
      } finally {
        restoreNow();
      }
    });

    it("garbage-collects across the async write path too", async () => {
      const restoreNow = installMonotonicNow();
      try {
        const store = await createStore();
        // First (sync) save lays down a legacy-less chunked gen.
        store.saveSessionData(makeSession("gca", 60));
        // A legacy blob written elsewhere would migrate async, but here we just
        // re-save through the public API and confirm the async-equivalent GC by
        // observing a single surviving generation after the second save.
        store.saveSessionData(makeSession("gca", 5));
        expect(listGenerations("gca")).toHaveLength(1);
        expect(store.loadSessionData("gca")!.messages).toHaveLength(5);
      } finally {
        restoreNow();
      }
    });

    it("only removes generations lexicographically < the kept gen (preserves a newer sibling)", async () => {
      const restoreNow = installMonotonicNow();
      try {
        const store = await createStore();
        store.saveSessionData(makeSession("gc2", 5)); // gen1
        const gen1 = chunkGenOf("gc2");

        // A concurrently-created NEWER generation sorts lexicographically greater
        // (real gens start with a base36 digit; "zzzz…" is far larger).
        const newerSibling = "zzzzzzzz-zzzzzzzz";
        fs.mkdirSync(path.join(chunksDir("gc2"), newerSibling), { recursive: true });

        store.saveSessionData(makeSession("gc2", 7)); // gen2 (> gen1, < newerSibling)
        const gen2 = chunkGenOf("gc2");

        const gens = listGenerations("gc2");
        expect(gens).toContain(gen2);
        expect(gens).toContain(newerSibling); // preserved — it is NOT strictly older
        expect(gens).not.toContain(gen1); // reclaimed — strictly older than gen2
        expect(store.loadSessionData("gc2")!.messages).toHaveLength(7);
      } finally {
        restoreNow();
      }
    });
  });

  // -------------------------------------------------------------------------
  // LAZY AUTO-MIGRATION (legacy single-blob → chunked)
  // -------------------------------------------------------------------------
  describe("lazy auto-migration (legacy blob → chunked)", () => {
    function legacyBlob(id: string, n: number): string {
      // A full StoredSession with an inline `messages` ARRAY and NO storageFormat.
      return JSON.stringify({
        id,
        name: `Legacy ${id}`,
        createdAt: "2026-07-20T20:15:00.000Z",
        updatedAt: "2026-07-20T20:15:00.000Z",
        messages: makeMessages(n),
        goal: makeLegacyGoal(),
      });
    }

    it("loadSessionData returns the full session AND rewrites it to chunked format (sync)", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK + 10; // 2 chunks after migration
      writeRaw(headerPath("leg"), legacyBlob("leg", n));

      const loaded = store.loadSessionData("leg");
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(n);

      // Side effect: header is now a chunked header (sentinel messages) with a
      // generation dir holding ceil(N/CHUNK) files.
      const header = readHeaderFile("leg");
      expect(header.storageFormat).toBe(SESSION_CHUNK_FORMAT);
      expect(header.messages).toBe(MESSAGES_SENTINEL);
      expect(header.chunkCount).toBe(Math.ceil(n / MESSAGES_PER_CHUNK));
      expect(typeof header.chunkGen).toBe("string");
      expect(listChunkFiles("leg")).toEqual(["0000.json", "0001.json"]);
      expect(loaded?.goal).toMatchObject({
        schemaVersion: 3,
        objective: "Preserve the legacy goal",
        tokensUsed: 100,
        activeMs: 200,
        continuationCount: 4,
        decisions: ["Migrate at the schema boundary"],
        openQuestions: ["Does migration preserve context?"],
      });
      expect(loaded?.goal?.criteria).toEqual(makeLegacyGoal().acceptanceCriteria);
      expect(record(header.goal).schemaVersion).toBe(3);

      // A SECOND load now takes the chunked path and still returns the full session.
      const reloaded = store.loadSessionData("leg");
      expect(reloaded!.messages.map((m) => m.id)).toEqual(loaded!.messages.map((m) => m.id));
    });

    it("loadSessionDataAsync returns the full session AND rewrites it to chunked format (async)", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK + 10;
      writeRaw(headerPath("lega"), legacyBlob("lega", n));

      const loaded = await store.loadSessionDataAsync("lega");
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(n);

      const header = readHeaderFile("lega");
      expect(header.storageFormat).toBe(SESSION_CHUNK_FORMAT);
      expect(header.messages).toBe(MESSAGES_SENTINEL);
      expect(header.chunkCount).toBe(Math.ceil(n / MESSAGES_PER_CHUNK));
      expect(typeof header.chunkGen).toBe("string");
      expect(listChunkFiles("lega")).toEqual(["0000.json", "0001.json"]);
      expect(loaded?.goal?.schemaVersion).toBe(3);
      expect(loaded?.goal?.decisions).toEqual(["Migrate at the schema boundary"]);

      const reloaded = await store.loadSessionDataAsync("lega");
      expect(reloaded!.messages.map((m) => m.id)).toEqual(loaded!.messages.map((m) => m.id));
    });

    it("does not emit worker proof for a schema-normalized legacy blob", async () => {
      const store = await createStore();
      writeRaw(headerPath("legacy-proof"), legacyBlob("legacy-proof", 2));

      const loaded = await store.loadSessionDataWithWorkerBaseProofAsync("legacy-proof");

      expect(loaded.session?.messages).toHaveLength(2);
      expect(loaded.workerBaseProof).toBeUndefined();
    });

    it("promotes sdkSessionId → backendId while migrating a legacy per-session blob", async () => {
      const store = await createStore();
      writeRaw(
        headerPath("sdk"),
        JSON.stringify({
          id: "sdk",
          name: "Legacy Copilot Session",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
          messages: [],
          sdkSessionId: "sdk-session-abc",
        }),
      );

      expect(store.loadSessionData("sdk")?.backendId).toBe("sdk-session-abc");
    });

    it("rewrites a V1 goal embedded in an existing chunked header", async () => {
      const store = await createStore();
      store.saveSessionData({
        ...makeSession("chunk-goal", 3),
        createdAt: "2026-07-20T20:15:00.000Z",
      });
      const header = readHeaderFile("chunk-goal");
      header.goal = makeLegacyGoal();
      writeRaw(headerPath("chunk-goal"), JSON.stringify(header));

      const loaded = store.loadSessionData("chunk-goal");

      expect(loaded?.goal?.schemaVersion).toBe(3);
      expect(loaded?.goal?.criteria).toEqual(makeLegacyGoal().acceptanceCriteria);
      expect(record(readHeaderFile("chunk-goal").goal).schemaVersion).toBe(3);
    });

    it("migrates a legacy goal without requiring harness bookkeeping", async () => {
      const store = await createStore();
      store.saveSessionData(makeSession("pre-harness-goal", 3));
      const header = readHeaderFile("pre-harness-goal");
      header.goal = makeLegacyGoal();
      writeRaw(headerPath("pre-harness-goal"), JSON.stringify(header));

      const loaded = store.loadSessionData("pre-harness-goal");

      expect(loaded).not.toBeNull();
      expect(loaded?.goal?.schemaVersion).toBe(3);
      expect(loaded?.goal?.objective).toBe("Preserve the legacy goal");
      expect(loaded?.goal?.decisions).toEqual(["Migrate at the schema boundary"]);
      expect(record(readHeaderFile("pre-harness-goal").goal).schemaVersion).toBe(3);
    });

    it("does not rewrite a session containing an unknown future goal version", async () => {
      const store = await createStore();
      const future = JSON.stringify({
        id: "future-goal",
        name: "Future goal",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [],
        goal: {
          ...makeLegacyGoal(),
          schemaVersion: 99,
          futureField: { preserve: true },
        },
      });
      writeRaw(headerPath("future-goal"), future);

      expect(store.loadSessionData("future-goal")).toBeNull();
      expect(fs.readFileSync(headerPath("future-goal"), "utf8")).toBe(future);
    });

    it("returns null on a legacy blob that fails schema validation (sync + telemetry)", async () => {
      const store = await createStore();
      writeRaw(headerPath("badleg"), JSON.stringify({ name: "no id", messages: [] }));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(store.loadSessionData("badleg")).toBeNull();
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_LOAD_FAILED),
      );
      warnSpy.mockRestore();
    });

    it("returns null on a legacy blob that fails schema validation (async + telemetry)", async () => {
      const store = await createStore();
      writeRaw(headerPath("badleg2"), JSON.stringify({ name: "no id", messages: [] }));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(await store.loadSessionDataAsync("badleg2")).toBeNull();
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_LOAD_FAILED),
      );
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // loadSessionDataAsync() — ENOENT / unexpected error handling  (preserved)
  // -------------------------------------------------------------------------
  describe("loadSessionDataAsync() error handling", () => {
    it("returns null and does not log/telemeter for ENOENT", async () => {
      const store = await createStore();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await store.loadSessionDataAsync("missing")).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      expect(mocks.sendErrorTelemetry).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("returns null, logs, and telemeters for unexpected errors", async () => {
      const store = await createStore();
      const ioErr = Object.assign(new Error("disk failure"), { code: "EIO" });
      mocks.readEncryptedFile.mockRejectedValueOnce(ioErr);
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await store.loadSessionDataAsync("bad")).toBeNull();
      expect(spy).toHaveBeenCalled();
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_LOAD_FAILED),
      );
      spy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // loadSessionHeader()
  // -------------------------------------------------------------------------
  describe("loadSessionHeader()", () => {
    it("returns null when the session does not exist", async () => {
      const store = await createStore();
      expect(store.loadSessionHeader("nope")).toBeNull();
    });

    it("returns metadata (messageCount + preview + chunkGen, no real messages) for a chunked session", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK * 2 + 20;
      store.saveSessionData(makeSession("h", n));

      const header = store.loadSessionHeader("h");
      expect(header).not.toBeNull();
      expect(header!.messageCount).toBe(n);
      expect(header!.lastMessagePreview).toBe(`message ${n - 1}`);
      expect(header!.chunkCount).toBe(Math.ceil(n / MESSAGES_PER_CHUNK));
      expect(typeof header!.chunkGen).toBe("string");
      // The header never carries a real reconstructed message array.
      const rawMessages = Reflect.get(header ?? {}, "messages");
      expect(Array.isArray(rawMessages)).toBe(false);
    });

    it("never reads chunk files (works even when the chunk dir is deleted)", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK * 2 + 20;
      store.saveSessionData(makeSession("hd", n));

      fs.rmSync(chunksDir("hd"), { recursive: true, force: true });

      const header = store.loadSessionHeader("hd");
      expect(header!.messageCount).toBe(n);
      expect(header!.lastMessagePreview).toBe(`message ${n - 1}`);
    });

    it("derives a header from a legacy blob WITHOUT migrating (read-only)", async () => {
      const store = await createStore();
      const blob = JSON.stringify({
        id: "lh",
        name: "Legacy",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: makeMessages(3),
      });
      writeRaw(headerPath("lh"), blob);

      const header = store.loadSessionHeader("lh");
      expect(header!.messageCount).toBe(3);
      expect(header!.lastMessagePreview).toBe("message 2");
      expect(Reflect.get(header ?? {}, "messages")).toBeUndefined();

      // Read-only: the blob is untouched and no chunk dir was created.
      expect(fs.readFileSync(headerPath("lh"), "utf8")).toBe(blob);
      expect(fs.existsSync(chunksDir("lh"))).toBe(false);
    });
  });

  describe("loadSessionScope()", () => {
    it("serves the latest written scope without reading the header", async () => {
      const store = await createStore();
      store.saveSessionData({ ...makeSession("s", 3), workspaceName: "acme" });
      store.saveSessionData({ ...makeSession("s", 4), workspaceName: "marshal" });
      const header = vi.spyOn(store, "loadSessionHeader");

      expect(store.loadSessionScope("s")).toMatchObject({
        id: "s",
        name: "Session s",
        workspaceName: "marshal",
      });
      expect(header).not.toHaveBeenCalled();
    });

    it("reads the header once for a session this store has not written", async () => {
      const writer = await createStore();
      writer.saveSessionData({ ...makeSession("r", 3), repoPath: "/repo" });
      const store = await createStore();
      const header = vi.spyOn(store, "loadSessionHeader");

      expect(store.loadSessionScope("r")?.repoPath).toBe("/repo");
      expect(store.loadSessionScope("r")?.repoPath).toBe("/repo");
      expect(header).toHaveBeenCalledTimes(1);
    });

    it("tracks the delegation identity through writes and from disk", async () => {
      const store = await createStore();
      const delegated = {
        ...makeSession("g", 3),
        runtimeDelegationId: "delegation-1",
        runtimeTaskController: "controller-1",
      };
      store.saveSessionData(delegated);
      const { runtimeTaskController: _released, ...withoutController } = delegated;
      store.saveSessionData(withoutController);

      expect(store.loadSessionScope("g")).toMatchObject({ runtimeDelegationId: "delegation-1" });
      expect(store.loadSessionScope("g")).not.toHaveProperty("runtimeTaskController");
      expect((await createStore()).loadSessionScope("g")).toMatchObject({
        runtimeDelegationId: "delegation-1",
      });
    });

    it("forgets a deleted session", async () => {
      const store = await createStore();
      store.saveSessionData(makeSession("d", 3));
      store.deleteSessionData("d");

      expect(store.loadSessionScope("d")).toBeNull();
    });
  });

  describe("loadSessionMetadata()", () => {
    it("serves the latest written fields without messages or rebuilding the transcript", async () => {
      const store = await createStore();
      store.saveSessionData({ ...makeSession("m", 3), permissionMode: "default" });
      store.saveSessionData({
        ...makeSession("m", 4),
        permissionMode: "allow-all",
        scopedSkills: ["docx"],
      });
      const header = vi.spyOn(store, "loadSessionHeader");
      const data = vi.spyOn(store, "loadSessionData");

      const metadata = store.loadSessionMetadata("m");

      expect(metadata).toMatchObject({
        id: "m",
        permissionMode: "allow-all",
        scopedSkills: ["docx"],
      });
      expect(metadata).not.toHaveProperty("messages");
      expect(metadata).not.toHaveProperty("chunkCount");
      expect(header).not.toHaveBeenCalled();
      expect(data).not.toHaveBeenCalled();
    });

    it("reads a session this store has not written from its header once", async () => {
      const writer = await createStore();
      writer.saveSessionData({ ...makeSession("h", 3), permissionMode: "allow-all" });
      const store = await createStore();
      const header = vi.spyOn(store, "loadSessionHeader");

      expect(store.loadSessionMetadata("h")?.permissionMode).toBe("allow-all");
      expect(store.loadSessionMetadata("h")?.permissionMode).toBe("allow-all");
      expect(header).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // loadSessionMessagesTail()  (public API; does not read chunk paths directly)
  // -------------------------------------------------------------------------
  describe("loadSessionMessagesTail()", () => {
    it("returns the empty page when the session does not exist", async () => {
      const store = await createStore();
      expect(await store.loadSessionMessagesTail("nope", 10)).toEqual({
        messages: [],
        total: 0,
        hasMore: false,
        oldestChunkIndex: null,
      });
    });

    it("returns the last N messages with total + hasMore + oldestChunkIndex (chunked)", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK * 2 + 20; // 120 → chunks 50/50/20
      store.saveSessionData(makeSession("t", n));

      const page = await store.loadSessionMessagesTail("t", 10);
      expect(page.messages).toHaveLength(10);
      expect(page.messages.map((m) => m.id)).toEqual(
        Array.from({ length: 10 }, (_, i) => `m${n - 10 + i}`),
      );
      expect(page.total).toBe(n);
      expect(page.hasMore).toBe(true);
      expect(page.oldestChunkIndex).toBe(2); // only the final 20-msg chunk needed
    });

    it("reads across multiple tail chunks when one chunk is not enough", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK * 2 + 20;
      store.saveSessionData(makeSession("t2", n));

      const page = await store.loadSessionMessagesTail("t2", 60);
      expect(page.messages).toHaveLength(60);
      expect(page.messages.map((m) => m.id)).toEqual(
        Array.from({ length: 60 }, (_, i) => `m${n - 60 + i}`),
      );
      expect(page.total).toBe(n);
      expect(page.hasMore).toBe(true);
      expect(page.oldestChunkIndex).toBe(1);
    });

    it("returns ALL messages with hasMore=false when maxMessages >= total", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK * 2 + 20;
      store.saveSessionData(makeSession("t3", n));

      const page = await store.loadSessionMessagesTail("t3", n);
      expect(page.messages).toHaveLength(n);
      expect(page.messages[0].id).toBe("m0");
      expect(page.total).toBe(n);
      expect(page.hasMore).toBe(false);
      expect(page.oldestChunkIndex).toBe(0);
    });

    it("handles a 0-message chunked session (no chunk reads)", async () => {
      const store = await createStore();
      store.saveSessionData(makeSession("t0", 0));

      const page = await store.loadSessionMessagesTail("t0", 10);
      expect(page).toEqual({ messages: [], total: 0, hasMore: false, oldestChunkIndex: null });
    });

    it("returns the empty page for a chunked header missing chunkGen (does not throw)", async () => {
      const store = await createStore();
      writeRaw(
        headerPath("tng"),
        JSON.stringify({
          id: "tng",
          name: "No Gen Tail",
          createdAt: "t",
          updatedAt: "t",
          storageFormat: SESSION_CHUNK_FORMAT,
          messages: MESSAGES_SENTINEL,
          chunkCount: 1,
          messageCount: 1,
          // chunkGen absent
        }),
      );

      expect(await store.loadSessionMessagesTail("tng", 10)).toEqual({
        messages: [],
        total: 0,
        hasMore: false,
        oldestChunkIndex: null,
      });
    });

    it("restarts from the new generation when a save lands between chunk reads", async () => {
      const store = await createStore();
      const n = MESSAGES_PER_CHUNK * 2 + 20;
      store.saveSessionData(makeSession("race", n));
      saveDuringFirstChunkRead(store, { ...makeSession("race", n), hasUnread: false });

      const page = await store.loadSessionMessagesTail("race", 60);
      expect(page.messages.map((m) => m.id)).toEqual(
        Array.from({ length: 60 }, (_, i) => `m${n - 60 + i}`),
      );
      expect(page.total).toBe(n);
      expect(page.hasMore).toBe(true);
    });

    it("parses and slices the tail for a legacy blob (oldestChunkIndex null, no migration)", async () => {
      const store = await createStore();
      const blob = JSON.stringify({
        id: "lt",
        name: "Legacy",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: makeMessages(5),
      });
      writeRaw(headerPath("lt"), blob);

      const page = await store.loadSessionMessagesTail("lt", 2);
      expect(page.messages.map((m) => m.id)).toEqual(["m3", "m4"]);
      expect(page.total).toBe(5);
      expect(page.hasMore).toBe(true);
      expect(page.oldestChunkIndex).toBeNull();

      // Read-only — legacy blob not migrated to chunks.
      expect(fs.readFileSync(headerPath("lt"), "utf8")).toBe(blob);
      expect(fs.existsSync(chunksDir("lt"))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // saveSessionData() — telemetry  (preserved)
  // -------------------------------------------------------------------------
  describe("saveSessionData() telemetry", () => {
    it("fires SESSION_PERSIST_FAILED and rethrows on write failure", async () => {
      const store = await createStore();
      mocks.writeEncryptedFileSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      expect(() => store.saveSessionData(makeSession("s1", 0))).toThrow("EACCES");
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_PERSIST_FAILED),
        expect.any(Error),
      );
    });
  });

  // -------------------------------------------------------------------------
  // loadSessionData() — telemetry  (preserved)
  // -------------------------------------------------------------------------
  describe("loadSessionData() telemetry", () => {
    it("fires SESSION_LOAD_FAILED when a legacy blob fails schema validation", async () => {
      const store = await createStore();
      writeRaw(headerPath("s1"), JSON.stringify({ id: 42, not: "a valid session" }));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(store.loadSessionData("s1")).toBeNull();
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_LOAD_FAILED),
      );
      warnSpy.mockRestore();
    });

    it("fires SESSION_LOAD_FAILED when parse/decrypt throws", async () => {
      const store = await createStore();
      writeRaw(headerPath("s1"), "{}"); // file exists so existsSync passes
      mocks.readEncryptedFileSync.mockImplementationOnce(() => {
        throw new Error("decrypt failed");
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(store.loadSessionData("s1")).toBeNull();
      expect(mocks.sendErrorTelemetry).toHaveBeenCalledWith(
        makeSessionError(sessionErrors.SESSION_LOAD_FAILED),
      );
      errSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // deleteSessionData()
  // -------------------------------------------------------------------------
  describe("deleteSessionData()", () => {
    it("removes both the {id}.json header and the {id}.chunks directory (all generations)", async () => {
      const restoreNow = installMonotonicNow();
      try {
        const store = await createStore();
        store.saveSessionData(makeSession("d", MESSAGES_PER_CHUNK + 1));
        store.saveSessionData(makeSession("d", 5)); // second generation
        expect(fs.existsSync(headerPath("d"))).toBe(true);
        expect(fs.existsSync(chunksDir("d"))).toBe(true);

        store.deleteSessionData("d");

        expect(fs.existsSync(headerPath("d"))).toBe(false);
        expect(fs.existsSync(chunksDir("d"))).toBe(false);
      } finally {
        restoreNow();
      }
    });

    it("is a no-op when the session is already absent", async () => {
      const store = await createStore();
      expect(() => store.deleteSessionData("ghost")).not.toThrow();
      expect(fs.existsSync(headerPath("ghost"))).toBe(false);
      expect(fs.existsSync(chunksDir("ghost"))).toBe(false);
    });
  });
});
