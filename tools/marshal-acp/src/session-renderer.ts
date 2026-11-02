import { SessionRecordSchema, type SessionRecord, type Turn } from "./types.ts";

const FRONTMATTER_FENCE = "---";

export function renderSession(rec: SessionRecord): string {
  const frontmatter = renderFrontmatter(rec);
  const body = [`# ${rec.title}`, "", ...rec.turns.flatMap((t, i) => renderTurn(t, i + 1))].join(
    "\n",
  );
  return `${FRONTMATTER_FENCE}\n${frontmatter}\n${FRONTMATTER_FENCE}\n\n${body}\n`;
}

export function appendTurn(existing: string, turn: Turn): string {
  const parsed = parseSession(existing);
  const updated: SessionRecord = {
    ...parsed,
    turns: [...parsed.turns, turn],
    completedAt: turn.at,
  };
  return renderSession(updated);
}

export function parseSession(md: string): SessionRecord {
  const fmEnd = md.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length + 1);
  if (!md.startsWith(`${FRONTMATTER_FENCE}\n`) || fmEnd < 0) {
    throw new Error("marshal-acp session markdown: missing frontmatter");
  }
  const fmText = md.slice(FRONTMATTER_FENCE.length + 1, fmEnd);
  const body = md.slice(fmEnd + `\n${FRONTMATTER_FENCE}\n`.length);
  const rec = parseFrontmatter(fmText);
  const bodies = extractTurnBodies(body);
  const turns = rec.turns.map((t, i) => ({ ...t, responseText: bodies[i] ?? "" }));
  return { ...rec, turns };
}

function extractTurnBodies(body: string): string[] {
  const turnStarts: number[] = [];
  const headingRe = /^## Turn \d+/gm;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    turnStarts.push(m.index);
  }
  if (turnStarts.length === 0) return [];

  const out: string[] = [];
  for (let i = 0; i < turnStarts.length; i++) {
    const start = turnStarts[i]!;
    const end = i + 1 < turnStarts.length ? turnStarts[i + 1]! : body.length;
    const section = body.slice(start, end);
    // Prompt is wrapped in a 4-backtick fence (renderTurn). Anchored to
    // start-of-line so a 3-backtick block inside the prompt body can't be
    // mistaken for the closing fence.
    const openerMatch = /^````\s*$/m.exec(section);
    if (!openerMatch) {
      out.push("");
      continue;
    }
    const afterOpener = openerMatch.index + openerMatch[0].length;
    const closerMatch = /^````\s*$/m.exec(section.slice(afterOpener));
    if (!closerMatch) {
      out.push("");
      continue;
    }
    const closerAbsEnd = afterOpener + closerMatch.index + closerMatch[0].length;
    const afterFence = section.slice(closerAbsEnd).replace(/^\n+/, "").replace(/\n+$/, "");
    out.push(afterFence === "_(empty)_" ? "" : afterFence);
  }
  return out;
}

function renderFrontmatter(rec: SessionRecord): string {
  const lines: string[] = [
    `title: ${quoteYaml(rec.title)}`,
    `sessionId: ${rec.sessionId}`,
    `runtime: ${rec.runtime}`,
    `cwd: ${quoteYaml(rec.cwd)}`,
    `permissionProfile: ${rec.permissionProfile}`,
    `startedAt: ${rec.startedAt}`,
  ];
  if (rec.completedAt) lines.push(`completedAt: ${rec.completedAt}`);
  lines.push("turns:");
  for (const t of rec.turns) {
    lines.push(`  - at: ${t.at}`);
    lines.push(`    promptText: ${quoteYaml(t.promptText)}`);
    if (t.stopReason) lines.push(`    stopReason: ${t.stopReason}`);
    if (t.usageOutputTokens !== undefined) {
      lines.push(`    usageOutputTokens: ${t.usageOutputTokens}`);
    }
    // responseText is in the body, not the frontmatter — kb-scale arbitrary
    // markdown is fragile to YAML-escape. Re-attached on parse from the body.
  }
  return lines.join("\n");
}

function parseFrontmatter(text: string): SessionRecord {
  const raw: Record<string, string> = {};
  const turns: Record<string, string>[] = [];
  let inTurns = false;
  let cur: Record<string, string> | null = null;

  for (const line of text.split("\n")) {
    if (/^turns:\s*$/.test(line)) {
      inTurns = true;
      continue;
    }
    if (!inTurns && /^[a-zA-Z]+:\s+/.test(line)) {
      const [k, ...rest] = line.split(": ");
      raw[k!] = unquoteYaml(rest.join(": "));
      continue;
    }
    if (inTurns) {
      const m = line.match(/^\s*-\s+at:\s+(.+)$/);
      if (m) {
        if (cur) turns.push(cur);
        cur = { at: m[1]!.trim() };
        continue;
      }
      const kv = line.match(/^\s+([a-zA-Z]+):\s+(.+)$/);
      if (kv && cur) cur[kv[1]!] = unquoteYaml(kv[2]!);
    }
  }
  if (cur) turns.push(cur);

  return SessionRecordSchema.parse({
    title: raw.title ?? "",
    sessionId: raw.sessionId ?? "",
    runtime: raw.runtime ?? "claude",
    cwd: raw.cwd ?? "",
    permissionProfile: raw.permissionProfile ?? "default",
    startedAt: raw.startedAt ?? new Date().toISOString(),
    completedAt: raw.completedAt,
    turns: turns.map((t) => ({
      at: t.at ?? "",
      promptText: t.promptText ?? "",
      responseText: "",
      ...(t.stopReason ? { stopReason: t.stopReason } : {}),
      ...(t.usageOutputTokens ? { usageOutputTokens: Number(t.usageOutputTokens) } : {}),
    })),
  });
}

function renderTurn(turn: Turn, idx: number): string[] {
  return [
    `## Turn ${idx} — ${turn.at}`,
    "",
    "**Prompt:**",
    "",
    // 4-backtick fence so a prompt containing a normal 3-backtick code block
    // ("explain this: ```ts ...```") can't be mistaken for the closer.
    // CommonMark: 4-tick opener requires 4+-tick closer.
    "````",
    turn.promptText,
    "````",
    "",
    turn.responseText || "_(empty)_",
    "",
  ];
}

function quoteYaml(s: string): string {
  if (s.length === 0) return '""';
  if (/[:#\n"']/.test(s)) return JSON.stringify(s);
  return s;
}

function unquoteYaml(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed.replace(/^'|'$/g, '"'));
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
