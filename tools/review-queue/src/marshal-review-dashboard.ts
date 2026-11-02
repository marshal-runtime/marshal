// Marshal-owned module.
import { spawn } from "node:child_process";

import {
  DashboardOutputSchema,
  type DashboardOutput,
  type DashboardPr,
  type RepoConfig,
} from "./marshal-review-types.ts";

const TIER_ORDER: Record<NonNullable<DashboardPr["tier"]>, number> = {
  maintainer: 0,
  trusted: 1,
  other: 2,
};

// Without this, a hung `gh pr list` leaves `tickRunning=true` in the
// orchestrator forever and every subsequent tick silently coalesces.
const DEFAULT_DASHBOARD_TIMEOUT_MS = 120_000;

export type RunDashboardOpts = {
  timeoutMs?: number;
};

export function parseDashboardJson(raw: string): DashboardOutput {
  return DashboardOutputSchema.parse(JSON.parse(raw));
}

export function dashboardPrsInPriorityOrder(out: DashboardOutput): DashboardPr[] {
  const stale = out.buckets.stale_my_review;
  const needs = [...out.buckets.needs_review].sort(
    (a, b) => (TIER_ORDER[a.tier ?? "other"] ?? 2) - (TIER_ORDER[b.tier ?? "other"] ?? 2),
  );
  const mine = out.buckets.my_prs_with_feedback;
  return [...stale, ...needs, ...mine];
}

export async function runDashboard(
  repo: RepoConfig,
  opts: RunDashboardOpts = {},
): Promise<DashboardOutput> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DASHBOARD_TIMEOUT_MS;
  const [cmd, ...args] = repo.dashboardCmd;
  if (!cmd) throw new Error("dashboardCmd is empty");
  return await new Promise<DashboardOutput>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: repo.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`dashboard timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(
          new Error(`dashboard exited ${code}: ${Buffer.concat(stderrChunks).toString().trim()}`),
        );
      }
      try {
        resolve(parseDashboardJson(Buffer.concat(stdoutChunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
  });
}
