// Marshal-owned module.
import fs from "node:fs/promises";
import path from "node:path";

import { sessionFilePath, sessionsDir } from "./paths.ts";
import { appendTurn, parseSession, renderSession } from "./session-renderer.ts";
import type { SessionRecord, Turn } from "./types.ts";

const MAX_SLUG_LEN = 40;

export function buildSessionFilename(startedAt: string, _sessionId: string, title: string): string {
  // Filename is `<ISO>-<slug>.md` — computable up-front (parent process for
  // --detach needs to print it before session/new has returned). The full
  // sessionId still lives in frontmatter for resume. ISO at millisecond
  // precision is unique enough for single-user concurrent runs.
  const isoSafe = startedAt.replace(/[:.]/g, "-");
  const slug = slugifyTitle(title);
  return `${isoSafe}-${slug}.md`;
}

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN);
  return slug.length > 0 ? slug : "session";
}

export async function writeSession(rec: SessionRecord): Promise<string> {
  const basename = buildSessionFilename(rec.startedAt, rec.sessionId, rec.title);
  const dir = sessionsDir();
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, basename);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, renderSession(rec), "utf8");
  await fs.rename(tmp, target);
  return target;
}

export async function appendTurnToFile(nameOrPath: string, turn: Turn): Promise<string> {
  const target = sessionFilePath(nameOrPath);
  const existing = await fs.readFile(target, "utf8");
  const updated = appendTurn(existing, turn);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, updated, "utf8");
  await fs.rename(tmp, target);
  return target;
}

export async function readSession(nameOrPath: string): Promise<SessionRecord> {
  const target = sessionFilePath(nameOrPath);
  const text = await fs.readFile(target, "utf8");
  return parseSession(text);
}

export async function listSessions(): Promise<string[]> {
  try {
    const entries = await fs.readdir(sessionsDir());
    return entries
      .filter((e) => e.endsWith(".md"))
      .sort()
      .reverse();
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
}
