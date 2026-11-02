import type { State, PrRow } from "./marshal-review-types.ts";

export function renderStatusMd(state: State, now: Date = new Date()): string {
  const lines: string[] = [];
  lines.push(`# marshal-review-queue status`);
  lines.push("");
  lines.push(`_generated: ${now.toISOString()}_`);
  lines.push("");
  lines.push(`- Running: ${state.running.length} / ${state.config.maxConcurrent}`);
  lines.push(`- Queued: ${state.queue.length}`);
  lines.push("");

  if (state.running.length > 0) {
    lines.push(`## Running`);
    lines.push("");
    for (const entry of state.running) {
      const pr = state.prs[entry.prNumber];
      if (!pr) continue;
      lines.push(
        `- **PR #${entry.prNumber}** — ${pr.title} _(${pr.author}, ${pr.tier}, ${pr.sizeBucket})_  `,
      );
      lines.push(
        `  session: \`${entry.sessionId}\`, started ${entry.startedAt}, sha \`${pr.currentHeadSha}\`  `,
      );
    }
    lines.push("");
  }

  if (state.queue.length > 0) {
    lines.push(`## Queued`);
    lines.push("");
    for (const n of state.queue) {
      const pr = state.prs[n];
      if (!pr) continue;
      lines.push(`- **PR #${n}** — ${pr.title} _(${pr.author}, ${pr.tier}, ${pr.sizeBucket})_`);
    }
    lines.push("");
  }

  const pending = listByStatus(state.prs, "pending-confirmation");
  if (pending.length > 0) {
    lines.push(`## Pending confirmation`);
    lines.push("");
    for (const [n, pr] of pending) {
      const last = pr.iterations.at(-1);
      const flag = pr.keepContextNextIteration ? " · _keep-context queued_" : "";
      lines.push(
        `- **PR #${n}** — ${pr.title} _(${pr.author})_, completed ${last?.completedAt ?? "—"}${flag}`,
      );
    }
    lines.push("");
    lines.push(
      `_After a meaningful chat in \`resume\`, run \`marshal-review-queue keep-context <pr>\` so the next iteration resumes the session instead of starting fresh._`,
    );
    lines.push("");
  }

  const failed = listByStatus(state.prs, "failed");
  const crashed = listByStatus(state.prs, "crashed");
  if (failed.length + crashed.length > 0) {
    lines.push(`## Failed / crashed`);
    lines.push("");
    for (const [n, pr] of [...failed, ...crashed]) {
      const last = pr.iterations.at(-1);
      lines.push(
        `- **PR #${n}** — ${pr.title}: ${pr.status}${last?.failureReason ? ` — ${last.failureReason}` : ""}`,
      );
    }
    lines.push("");
  }

  // Cooldown footer: any PR whose latest iteration started within cooldown window
  const cooldownMs = state.config.cooldownMinutes * 60_000;
  const cooling: { n: number; until: Date }[] = [];
  for (const [k, pr] of Object.entries(state.prs)) {
    const last = pr.iterations.at(-1);
    if (!last) continue;
    const start = new Date(last.startedAt).getTime();
    const until = start + cooldownMs;
    if (until > now.getTime() && pr.status !== "running" && pr.status !== "queued") {
      cooling.push({ n: Number(k), until: new Date(until) });
    }
  }
  if (cooling.length > 0) {
    lines.push(`## In cooldown`);
    lines.push("");
    for (const c of cooling) {
      lines.push(`- **PR #${c.n}** — until ${c.until.toISOString()}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function listByStatus(prs: State["prs"], status: PrRow["status"]): [number, PrRow][] {
  const out: [number, PrRow][] = [];
  for (const [k, v] of Object.entries(prs)) {
    if (v.status === status) out.push([Number(k), v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
