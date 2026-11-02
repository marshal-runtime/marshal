// Marshal-owned module.
import type { AgentRuntime, Iteration, IterationStatus } from "./marshal-review-types.ts";

// String-typed sets so the membership check uses Set.has(string) — avoids
// the unsafe-cast lint that fires when narrowing through a Set<UnionLiteral>.
const AGENT_RUNTIMES: ReadonlySet<string> = new Set<AgentRuntime>(["claude", "copilot"]);
const ITERATION_STATUSES: ReadonlySet<string> = new Set<IterationStatus>([
  "running",
  "pending-confirmation",
  "superseded",
  "confirmed",
  "dismissed",
  "failed",
  "crashed",
]);

function isAgentRuntime(v: string): v is AgentRuntime {
  return AGENT_RUNTIMES.has(v);
}
function isIterationStatus(v: string): v is IterationStatus {
  return ITERATION_STATUSES.has(v);
}

export type PrSummary = {
  number: number;
  url: string;
  title: string;
  author: string;
};

export function renderInitial(pr: PrSummary, iter: Iteration, body: string): string {
  return [
    renderFrontmatter(pr, [iter], iter.status),
    "",
    `# PR #${pr.number} — ${pr.title}`,
    "",
    renderIterationHeader(1, iter, true),
    "",
    body.trimEnd(),
    "",
  ].join("\n");
}

export function appendIteration(existing: string, newIter: Iteration, body: string): string {
  const parsed = parse(existing);
  const allIters = [newIter, ...parsed.iterations];
  const newCount = allIters.length;

  const previousBodySection = wrapInDetails(
    parsed.iterations[0]
      ? `Iteration ${parsed.iterations.length} · <code>${parsed.iterations[0].sha}</code> (superseded ${dateOnly(parsed.iterations[0].completedAt ?? parsed.iterations[0].startedAt)})`
      : "Previous iteration",
    parsed.latestBody,
  );

  return [
    renderFrontmatter({ ...parsed.pr }, allIters, newIter.status),
    "",
    `# PR #${parsed.pr.number} — ${parsed.pr.title}`,
    "",
    renderIterationHeader(newCount, newIter, true),
    "",
    body.trimEnd(),
    "",
    previousBodySection,
    parsed.olderDetails ? "\n" + parsed.olderDetails : "",
  ]
    .filter((s) => s.length > 0 || s === "")
    .join("\n");
}

function renderFrontmatter(
  pr: PrSummary,
  iterations: Iteration[],
  topStatus: Iteration["status"],
): string {
  const itersYaml = iterations
    .map((it) =>
      [
        `  - sha: ${it.sha}`,
        `    sessionId: ${it.sessionId}`,
        `    agentRuntime: ${it.agentRuntime}`,
        `    startedAt: ${it.startedAt}`,
        ...(it.completedAt ? [`    completedAt: ${it.completedAt}`] : []),
        `    status: ${it.status}`,
        ...(it.stopReason ? [`    stopReason: ${it.stopReason}`] : []),
        ...(it.usageOutputTokens !== undefined
          ? [`    usageOutputTokens: ${it.usageOutputTokens}`]
          : []),
        ...(it.failureReason ? [`    failureReason: ${quoteYaml(it.failureReason)}`] : []),
      ].join("\n"),
    )
    .join("\n");

  return [
    "---",
    `pr: ${pr.number}`,
    `url: ${pr.url}`,
    `title: ${quoteYaml(pr.title)}`,
    `author: ${pr.author}`,
    `status: ${topStatus}`,
    `iterations:`,
    itersYaml,
    "---",
  ].join("\n");
}

function renderIterationHeader(n: number, it: Iteration, latest: boolean): string {
  // Surface the runtime (claude | copilot) in the body so it's visible without
  // parsing the frontmatter. Also fold stopReason + outputTokens into the latest
  // header so the cutoff cause is glance-able for incomplete reviews.
  const parts = [`## Iteration ${n} · \`${it.sha}\` · ${it.agentRuntime}`];
  if (latest) {
    const meta: string[] = [`latest, ${it.status}`];
    if (it.stopReason) meta.push(`stop=${it.stopReason}`);
    if (it.usageOutputTokens !== undefined) meta.push(`out=${it.usageOutputTokens}t`);
    parts.push(`(${meta.join(", ")})`);
  }
  return parts.join(" ").trimEnd();
}

function wrapInDetails(summary: string, body: string): string {
  return ["<details>", `<summary>${summary}</summary>`, "", body.trimEnd(), "", "</details>"].join(
    "\n",
  );
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function quoteYaml(s: string): string {
  if (/[:#\n"']/.test(s)) return JSON.stringify(s);
  return s;
}

type Parsed = {
  pr: PrSummary;
  iterations: Iteration[];
  latestBody: string;
  olderDetails: string;
};

function parse(existing: string): Parsed {
  const fmMatch = existing.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) throw new Error("review markdown missing frontmatter");
  const fm = parseFrontmatter(fmMatch[1]!);
  const afterFm = existing.slice(fmMatch[0].length);

  const h1Match = afterFm.match(/^\s*# PR #\d+ — [^\n]+\n+/);
  const afterH1 = h1Match ? afterFm.slice(h1Match[0].length) : afterFm;

  const iterStart = afterH1.search(/^## Iteration \d+ ·/m);
  if (iterStart < 0) throw new Error("review markdown missing iteration header");
  const fromLatest = afterH1.slice(iterStart);

  const detailsStart = fromLatest.indexOf("<details>");
  const latestSection = detailsStart >= 0 ? fromLatest.slice(0, detailsStart) : fromLatest;

  const latestBody = latestSection.replace(/^## Iteration \d+ ·[^\n]*\n+/, "").trimEnd();
  const olderDetails = detailsStart >= 0 ? fromLatest.slice(detailsStart).trimEnd() : "";

  return {
    pr: { number: fm.pr, url: fm.url, title: fm.title, author: fm.author },
    iterations: fm.iterations,
    latestBody,
    olderDetails,
  };
}

function parseFrontmatter(yaml: string): {
  pr: number;
  url: string;
  title: string;
  author: string;
  // Loosely typed: hand-rolled YAML parser reads whatever fields the file
  // contains. renderFrontmatter only reads the known Iteration fields by
  // name, so missing/extra keys round-trip safely.
  iterations: Iteration[];
} {
  const lines = yaml.split("\n");
  const out: Record<string, unknown> = {};
  // Build iteration objects in a loose shape during parsing; the caller pushes
  // them into structured frontmatter (re-emitted by renderFrontmatter, which
  // only reads the fields it knows about). We don't validate against
  // IterationSchema here because parsing should be tolerant — a markdown file
  // hand-edited by a user might have a malformed iteration we still want to
  // pass through verbatim.
  const iters: Record<string, string>[] = [];
  let inIters = false;
  let cur: Record<string, string> | null = null;
  for (const line of lines) {
    if (/^iterations:\s*$/.test(line)) {
      inIters = true;
      continue;
    }
    if (!inIters && /^[a-zA-Z_]+: /.test(line)) {
      const [k, ...rest] = line.split(": ");
      out[k!] = unquoteYaml(rest.join(": "));
      continue;
    }
    if (inIters) {
      const m = line.match(/^\s*-\s+sha:\s+(.+)$/);
      if (m) {
        if (cur) iters.push(cur);
        cur = { sha: m[1]!.trim() };
        continue;
      }
      const kv = line.match(/^\s+([a-zA-Z]+):\s+(.+)$/);
      if (kv && cur) {
        cur[kv[1]!] = unquoteYaml(kv[2]!);
      }
    }
  }
  if (cur) iters.push(cur);

  return {
    pr: Number(out.pr),
    url: String(out.url),
    title: String(out.title),
    author: String(out.author),
    iterations: iters.map(coerceIteration),
  };
}

/** YAML parsing produces every field as a string. Iteration declares numeric
 *  and boolean fields, so coerce here at the parser boundary instead of
 *  casting `as unknown as Iteration[]` and lying about the runtime shape. */
function coerceIteration(raw: Record<string, string>): Iteration {
  const runtime = raw.agentRuntime ?? "";
  const status = raw.status ?? "";
  const it: Iteration = {
    sha: raw.sha ?? "",
    sessionId: raw.sessionId ?? "",
    agentRuntime: isAgentRuntime(runtime) ? runtime : "claude",
    startedAt: raw.startedAt ?? "",
    status: isIterationStatus(status) ? status : "failed",
  };
  if (raw.completedAt) it.completedAt = raw.completedAt;
  if (raw.failureReason) it.failureReason = raw.failureReason;
  if (raw.stopReason) it.stopReason = raw.stopReason;
  if (raw.usageOutputTokens) {
    const n = Number(raw.usageOutputTokens);
    if (Number.isFinite(n) && n >= 0) it.usageOutputTokens = n;
  }
  return it;
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
