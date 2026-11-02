/**
 * Performance benchmark tests — measure tool call timing over multiple runs.
 *
 * Requires real Copilot authentication and makes live API + browser tool calls.
 * NOT included in normal CI — run explicitly with:
 *
 *   pnpm run test:perf
 *
 * Results are written to e2e/perf-results.json.
 *
 * Two scenarios are measured:
 *   1. simple-page-summary  — visit one page, extract content
 *   2. multi-page-summary   — visit a page and follow nav bar links
 *
 * Note on measurement accuracy: timings are renderer-perceived (IPC latency
 * included). This is consistent across branches so deltas are meaningful, but
 * absolute values will be slightly higher than actual tool execution time.
 * IPC overhead is constant and cancels out in comparisons.
 */

/* eslint-disable playwright/no-conditional-in-test, playwright/no-wait-for-timeout, playwright/no-skipped-test */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import {
  test as base,
  _electron,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RUNS = 5;
const RUN_TIMEOUT_MS = 15 * 60_000; // 15 min per run
const RESULTS_FILE = path.join(__dirname, "perf-results.json");
// Cross-platform temp dir — avoids /tmp/... which doesn't exist on Windows
const PERF_USER_DATA_DIR = path.join(os.tmpdir(), "m-perf-test");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolTiming {
  toolName: string;
  toolCallId: string;
  startMs: number;
  elapsedMs: number;
}

interface RunResult {
  run: number;
  totalMs: number;
  tools: ToolTiming[];
  error?: string;
}

interface ScenarioSummary {
  successfulRuns: number;
  avgTotalMs: number;
  minTotalMs: number;
  maxTotalMs: number;
  /** Total time minus sum of all tool durations — approximates LLM think time. */
  avgLlmOverheadMs: number;
  /** Average / min / max tool calls per run. */
  avgToolCalls: number;
  minToolCalls: number;
  maxToolCalls: number;
  toolStats: Record<string, { avgMs: number; minMs: number; maxMs: number; calls: number }>;
  /** Starts with no matching end event — non-zero means dropped timings. */
  orphanedStarts: number;
  /** Runs where tool time ranges overlapped — LLM overhead is understated for these. */
  runsWithParallelTools: number;
}

interface ScenarioResult {
  scenario: string;
  prompt: string;
  runs: RunResult[];
  summary: ScenarioSummary;
}

interface PerfResults {
  timestamp: string;
  scenarios: ScenarioResult[];
}

/** Shape of the custom properties injected into the renderer window. */
interface PerfWindow extends Window {
  __perfReset: () => void;
  __perfToolTimings: ToolTiming[];
  // Queue per id — toolCallId is NOT unique across calls, so we store a FIFO
  // array and pop the oldest entry on each matching end event.
  __perfToolStarts: Record<string, Array<{ t: number; name: string }>>;
  __perfOrphanedStarts: number;
}

/** Minimal type for the copilot event wrapper received in the renderer. */
interface RuntimeEventData {
  toolCallId?: string;
  toolName?: string;
  mcpToolName?: string;
  /** Raw arguments passed to the tool (shape varies per tool). */
  arguments?: Record<string, unknown>;
}
interface RuntimeEvent {
  type: string;
  data?: RuntimeEventData;
}
interface CopilotWrapped {
  event?: RuntimeEvent;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    name: "simple-page-summary",
    // Use Hacker News so live content forces a real browser tool call every run
    prompt:
      "Use the browser tool to navigate to https://news.ycombinator.com RIGHT NOW and tell me the exact titles and point scores of the top 5 stories currently on the front page. You must use browser tools — do not answer from memory.",
  },
  {
    name: "multi-page-summary",
    prompt:
      "Use the browser tool to navigate to https://aka.ms/iOSPortal, summarize the main content you see, then follow the first 3 links in the navigation bar and give a brief summary of each linked page. You must use browser tools — do not answer from memory.",
  },
];

// ---------------------------------------------------------------------------
// Timing collector — injected into the renderer once per app launch
// ---------------------------------------------------------------------------

async function installTimingCollector(page: Page): Promise<void> {
  await page.evaluate(() => {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- PerfWindow narrowing for E2E instrumentation
    const w = window as unknown as PerfWindow;

    w.__perfReset = () => {
      w.__perfToolTimings = [];
      w.__perfToolStarts = {};
      w.__perfOrphanedStarts = 0;
    };
    w.__perfReset();

    // Attach an extra listener — copilotAPI.onEvent allows multiple subscribers
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- copilotAPI injected by preload bridge, not in Window type
    const copilotWindow = window as unknown as {
      copilotAPI: { onEvent: (cb: (w: CopilotWrapped) => void) => void };
    };
    copilotWindow.copilotAPI.onEvent((wrapped: CopilotWrapped) => {
      const event = wrapped?.event;
      if (!event) return;
      const data = event.data ?? {};

      if (event.type === "tool.execution_start") {
        const rawName = data.toolName ?? data.mcpToolName ?? "unknown";
        // For bash calls, extract the playwright subcommand from the arguments so
        // the breakdown is as granular as named MCP tools (playwright-browser_navigate etc.)
        let effectiveName = rawName;
        if (rawName === "bash" || rawName === "run_in_terminal") {
          const cmd = String(
            // oxlint-disable-next-line no-base-to-string -- values are coerced via String() intentionally
            data.arguments?.command ?? data.arguments?.input ?? data.arguments?.cmd ?? "",
          );
          const m = cmd.match(/playwright(?:-cli|_cli|_mcp)?(?:\.[^\s]*)?\s+(\w+)/);
          if (m) effectiveName = `playwright-cli:${m[1]}`;
        }
        // SDK hooks don't provide a unique toolCallId (always "").
        // Key on effectiveName instead and use a FIFO queue to handle concurrent
        // calls to the same tool — elapsed times may be swapped if they complete
        // out-of-order, which is acceptable for diagnostic purposes.
        if (!w.__perfToolStarts[effectiveName]) w.__perfToolStarts[effectiveName] = [];
        w.__perfToolStarts[effectiveName].push({ t: Date.now(), name: effectiveName });
      } else if (event.type === "tool.execution_end" || event.type === "tool.execution_complete") {
        const rawName = data.toolName ?? data.mcpToolName ?? "unknown";
        const queue = w.__perfToolStarts[rawName];
        const entry = queue?.shift(); // FIFO: oldest start for this tool name
        if (entry !== undefined) {
          if (queue.length === 0) delete w.__perfToolStarts[rawName];
          w.__perfToolTimings.push({
            toolName: entry.name, // preserves playwright-cli:subcommand from start
            toolCallId: data.toolCallId ?? "",
            startMs: entry.t,
            elapsedMs: Date.now() - entry.t,
          });
        }
        // else: end event with no matching start — benign (pre-reset tool finishing)
      }
    });
  });
}

async function resetCollector(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Count any unmatched starts before resetting — they are orphaned
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- PerfWindow narrowing for E2E instrumentation
    const w = window as unknown as PerfWindow;
    w.__perfOrphanedStarts =
      (w.__perfOrphanedStarts ?? 0) +
      Object.values(w.__perfToolStarts ?? {}).reduce((n, q) => n + q.length, 0);
    w.__perfReset?.();
  });
}

async function collectTimings(page: Page): Promise<{ timings: ToolTiming[]; orphaned: number }> {
  return page.evaluate(() => {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- PerfWindow narrowing for E2E instrumentation
    const w = window as unknown as PerfWindow;
    // Unmatched starts still in the map at collection time are orphaned
    const orphaned =
      (w.__perfOrphanedStarts ?? 0) +
      Object.values(w.__perfToolStarts ?? {}).reduce((n, q) => n + q.length, 0);
    return { timings: w.__perfToolTimings ?? [], orphaned };
  });
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function buildSummary(runs: RunResult[], totalOrphaned: number): ScenarioSummary {
  const successful = runs.filter((r) => !r.error);
  if (successful.length === 0) {
    return {
      successfulRuns: 0,
      avgTotalMs: 0,
      minTotalMs: 0,
      maxTotalMs: 0,
      avgLlmOverheadMs: 0,
      avgToolCalls: 0,
      minToolCalls: 0,
      maxToolCalls: 0,
      toolStats: {},
      orphanedStarts: totalOrphaned,
      runsWithParallelTools: 0,
    };
  }

  const totals = successful.map((r) => r.totalMs);
  const avgTotalMs = totals.reduce((a, b) => a + b, 0) / totals.length;
  const toolCounts = successful.map((r) => r.tools.length);

  const byTool = new Map<string, number[]>();
  const llmOverheads: number[] = [];
  let runsWithParallelTools = 0;
  for (const run of successful) {
    const toolTotal = run.tools.reduce((sum, t) => sum + t.elapsedMs, 0);
    // Detect parallel tool execution: sort by start time and check for overlapping ranges
    const sorted = [...run.tools].sort((a, b) => a.startMs - b.startMs);
    const hasOverlap = sorted.some(
      (t, i) => i > 0 && t.startMs < sorted[i - 1].startMs + sorted[i - 1].elapsedMs,
    );
    if (hasOverlap) runsWithParallelTools++;
    llmOverheads.push(run.totalMs - toolTotal);
    for (const t of run.tools) {
      const arr = byTool.get(t.toolName) ?? [];
      arr.push(t.elapsedMs);
      byTool.set(t.toolName, arr);
    }
  }

  const toolStats: Record<string, { avgMs: number; minMs: number; maxMs: number; calls: number }> =
    {};
  for (const [name, times] of byTool) {
    toolStats[name] = {
      avgMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      calls: times.length,
    };
  }

  return {
    successfulRuns: successful.length,
    avgTotalMs: Math.round(avgTotalMs),
    minTotalMs: Math.min(...totals),
    maxTotalMs: Math.max(...totals),
    avgLlmOverheadMs: Math.round(llmOverheads.reduce((a, b) => a + b, 0) / llmOverheads.length),
    avgToolCalls: Math.round(toolCounts.reduce((a, b) => a + b, 0) / toolCounts.length),
    minToolCalls: Math.min(...toolCounts),
    maxToolCalls: Math.max(...toolCounts),
    toolStats,
    orphanedStarts: totalOrphaned,
    runsWithParallelTools,
  };
}

function printSummary(result: ScenarioResult): void {
  const s = result.summary;
  const hr = "─".repeat(60);
  console.log(`\n${hr}`);
  console.log(`Scenario : ${result.scenario}`);
  console.log(`Runs     : ${s.successfulRuns}/${result.runs.length} successful`);
  if (s.successfulRuns > 0) {
    const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const fmt2 = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
    console.log(
      `Total    : avg ${fmt(s.avgTotalMs)}  min ${fmt(s.minTotalMs)}  max ${fmt(s.maxTotalMs)}`,
    );
    console.log(`LLM time : avg ${fmt(s.avgLlmOverheadMs)}  (total − Σ tool durations)`);
    console.log(
      `Tool calls/run: avg ${s.avgToolCalls}  min ${s.minToolCalls}  max ${s.maxToolCalls}`,
    );
    if (s.orphanedStarts > 0) {
      console.log(`⚠ Orphaned tool starts: ${s.orphanedStarts} (timings may be incomplete)`);
    }
    if (s.runsWithParallelTools > 0) {
      console.log(
        `⚠ Parallel tools detected in ${s.runsWithParallelTools}/${result.runs.length} runs — LLM overhead is understated for those runs`,
      );
    }
    if (Object.keys(s.toolStats).length > 0) {
      console.log("Tools    : avg / min / max  (calls)");
      for (const [name, st] of Object.entries(s.toolStats)) {
        console.log(
          `  ${name.padEnd(40)} ${fmt2(st.avgMs)} / ${fmt2(st.minMs)} / ${fmt2(st.maxMs)}  (×${st.calls})`,
        );
      }
    }
  }
  console.log("Per-run breakdown:");
  for (const run of result.runs) {
    if (run.error) {
      console.log(`  run ${run.run}: FAILED: ${run.error}`);
      continue;
    }
    const toolTotal = run.tools.reduce((sum, t) => sum + t.elapsedMs, 0);
    const llm = run.totalMs - toolTotal;
    console.log(
      `  run ${run.run}: ${(run.totalMs / 1000).toFixed(1)}s total  llm ~${(llm / 1000).toFixed(1)}s  ${run.tools.length} tool calls`,
    );
    // Per-tool detail for this run
    const byName = new Map<string, number[]>();
    for (const t of run.tools) {
      const arr = byName.get(t.toolName) ?? [];
      arr.push(t.elapsedMs);
      byName.set(t.toolName, arr);
    }
    for (const [name, times] of byName) {
      const calls = times.map((ms) => `${(ms / 1000).toFixed(2)}s`).join(", ");
      console.log(`    ${name}: [${calls}]`);
    }
  }
  console.log(hr);
}

// ---------------------------------------------------------------------------
// Fixture — real app, no mock mode
// ---------------------------------------------------------------------------

const test = base.extend<{ app: ElectronApplication; page: Page }>({
  app: async ({}, use) => {
    const app = await _electron.launch({
      // Use a dedicated user-data-dir so the single-instance lock doesn't
      // collide with a running production instance of the app.
      args: [".", `--user-data-dir=${PERF_USER_DATA_DIR}`],
      env: { ...process.env } as Record<string, string>, // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- process.env values may be undefined but Playwright accepts Record<string, string>
      cwd: path.resolve(__dirname, ".."),
    });
    await use(app);
    await app.close();
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow();
    await page.locator("nav[aria-label='Main navigation']").waitFor({ timeout: 15_000 });
    await use(page);
  },
});

// No retries for perf tests — a failure is a real failure
test.describe.configure({ retries: 0 });

// ---------------------------------------------------------------------------
// Helpers used inside tests
// ---------------------------------------------------------------------------

/** Wait for the app to be ready: authenticated and chat textarea enabled. */
async function waitForReady(page: Page): Promise<void> {
  const authVisible = await page
    .locator('button:has-text("Sign in"), button:has-text("Log in"), [data-testid="auth-button"]')
    .isVisible()
    .catch(() => false);
  if (authVisible) {
    test.skip(true, "App is not authenticated — sign in and re-run the perf tests.");
  }
  await page.locator("textarea:not([disabled])").waitFor({ timeout: 30_000 });
}

/** Send a message and wait for the response to finish.
 *  The textarea gets the CSS class "guiding" when isWaiting=true (ChatInput).
 */
async function sendAndWait(page: Page, prompt: string): Promise<void> {
  await page.locator("textarea.prompt-input").fill(prompt);
  await page.locator("textarea.prompt-input").press("Enter");
  // Confirm send started — prompt gets "guiding" class
  await page.locator("textarea.prompt-input.guiding").waitFor({ timeout: 15_000 });
  // Wait for response to complete — "guiding" removed after 1.5s idle debounce
  await page.locator("textarea.prompt-input:not(.guiding)").waitFor({ timeout: RUN_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

for (const scenario of SCENARIOS) {
  test(`perf: ${scenario.name}`, async ({ page }) => {
    test.setTimeout(RUNS * RUN_TIMEOUT_MS + 120_000);

    await waitForReady(page);
    await installTimingCollector(page);

    const runs: RunResult[] = [];
    let totalOrphaned = 0;

    for (let run = 1; run <= RUNS; run++) {
      console.log(`\n[${scenario.name}] run ${run}/${RUNS} — starting`);

      // Between runs: open a new session so the model has no prior context
      // (otherwise it caches the answer and skips tool calls).
      // Wait 2 s after clicking so the session.idle debounce (1500 ms) settles
      // before we send — otherwise it fires mid-send and clears isWaiting early.
      if (run > 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential test steps
        await page.locator('button[data-testid="new-chat-btn"]').click();
        // eslint-disable-next-line no-await-in-loop -- sequential test steps
        await page.locator("textarea.prompt-input:not(.guiding)").waitFor({ timeout: 15_000 });
        // eslint-disable-next-line no-await-in-loop -- sequential test steps
        await page.waitForTimeout(2000);
        // eslint-disable-next-line no-await-in-loop -- sequential test steps
        await installTimingCollector(page);
      }

      // eslint-disable-next-line no-await-in-loop -- sequential test steps
      await resetCollector(page);
      const t0 = Date.now();

      try {
        // eslint-disable-next-line no-await-in-loop -- sequential test steps
        await sendAndWait(page, scenario.prompt);
        const totalMs = Date.now() - t0;
        // eslint-disable-next-line no-await-in-loop -- sequential test steps
        const { timings, orphaned } = await collectTimings(page);
        totalOrphaned += orphaned;

        runs.push({ run, totalMs, tools: timings });
        console.log(
          `[${scenario.name}] run ${run}/${RUNS} — done in ${(totalMs / 1000).toFixed(1)}s, ${timings.length} tool calls`,
        );
      } catch (err) {
        const totalMs = Date.now() - t0;
        const msg = err instanceof Error ? err.message : String(err);
        runs.push({ run, totalMs, tools: [], error: msg });
        console.log(`[${scenario.name}] run ${run}/${RUNS} — FAILED: ${msg}`);
      }
    }

    const result: ScenarioResult = {
      scenario: scenario.name,
      prompt: scenario.prompt,
      runs,
      summary: buildSummary(runs, totalOrphaned),
    };

    // Append / merge into results file
    let existing: PerfResults = { timestamp: new Date().toISOString(), scenarios: [] };
    if (fs.existsSync(RESULTS_FILE)) {
      try {
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse result typed to known schema
        existing = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")) as PerfResults;
      } catch {
        // corrupt file — start fresh
      }
    }
    existing.timestamp = new Date().toISOString();
    const idx = existing.scenarios.findIndex((s) => s.scenario === result.scenario);
    if (idx >= 0) {
      existing.scenarios[idx] = result;
    } else {
      existing.scenarios.push(result);
    }
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(existing, null, 2));

    printSummary(result);

    expect(result.summary.successfulRuns).toBeGreaterThan(0);
    expect(result.runs).toHaveLength(RUNS);
  });
}
