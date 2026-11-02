import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  appendTurnToFile,
  buildSessionFilename,
  listSessions,
  readSession,
  writeSession,
} from "../src/persistence.ts";
import type { SessionRecord } from "../src/types.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "macp-"));
  process.env.MARSHAL_ACP_HOME = tmp;
});

afterEach(async () => {
  delete process.env.MARSHAL_ACP_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

const baseRecord = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  title: "summarize this PR",
  sessionId: "sess-abcd-1234",
  runtime: "claude",
  cwd: "/repo",
  permissionProfile: "default",
  startedAt: "2026-05-12T10:00:00.000Z",
  completedAt: "2026-05-12T10:01:00.000Z",
  turns: [
    {
      at: "2026-05-12T10:00:00.000Z",
      promptText: "summarize",
      responseText: "## Findings\n\n- it does X\n",
    },
  ],
  ...overrides,
});

describe("buildSessionFilename", () => {
  it("uses ISO date + slugified title only; sessionId is ignored (parent forking needs it computable up-front)", () => {
    const name = buildSessionFilename(
      "2026-05-12T10:00:00.000Z",
      "sess-abcd-1234",
      "Summarize PR #42!",
    );
    expect(name).toMatch(/^2026-05-12T10-00-00-000Z-summarize-pr-42\.md$/);
  });

  it("falls back to 'session' when title slugifies to empty", () => {
    const name = buildSessionFilename("2026-05-12T10-00Z", "abc", "????");
    expect(name).toContain("-session.md");
  });

  it("ignores sessionId entirely (empty or populated produces the same name)", () => {
    const empty = buildSessionFilename("2026-05-12T10-00Z", "", "hello");
    const populated = buildSessionFilename("2026-05-12T10-00Z", "sess-xyz", "hello");
    expect(empty).toBe(populated);
  });
});

describe("writeSession + readSession + listSessions", () => {
  it("writes a session and reads it back via frontmatter", async () => {
    const rec = baseRecord();
    const filePath = await writeSession(rec);
    expect(filePath).toMatch(/sessions[\\/]/);
    const parsed = await readSession(path.basename(filePath));
    expect(parsed.sessionId).toBe(rec.sessionId);
    expect(parsed.turns).toHaveLength(1);
    // Regression: the body-extraction fix (responseText recovered from body
    // because frontmatter doesn't carry it) must survive the integration
    // path, not just the renderer-level round-trip tested in
    // session-renderer.test.ts.
    expect(parsed.turns[0]?.responseText).toContain("it does X");
  });

  it("readSession also accepts an absolute path (basename-or-abs)", async () => {
    const rec = baseRecord();
    const filePath = await writeSession(rec);
    const parsed = await readSession(filePath);
    expect(parsed.sessionId).toBe(rec.sessionId);
  });

  it("lists sessions newest-first", async () => {
    await writeSession(baseRecord({ startedAt: "2026-05-10T00:00:00.000Z", title: "older" }));
    await writeSession(baseRecord({ startedAt: "2026-05-12T00:00:00.000Z", title: "newer" }));
    const names = await listSessions();
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("newer");
    expect(names[1]).toContain("older");
  });

  it("returns empty when sessions dir doesn't exist", async () => {
    const names = await listSessions();
    expect(names).toEqual([]);
  });
});

describe("appendTurnToFile", () => {
  it("appends a turn to an existing session and updates completedAt", async () => {
    const filePath = await writeSession(baseRecord());
    const basename = path.basename(filePath);
    await appendTurnToFile(basename, {
      at: "2026-05-12T10:05:00.000Z",
      promptText: "follow up",
      responseText: "tests look fine\n",
      stopReason: "end_turn",
    });
    const reread = await readSession(basename);
    expect(reread.turns).toHaveLength(2);
    expect(reread.completedAt).toBe("2026-05-12T10:05:00.000Z");
  });
});
