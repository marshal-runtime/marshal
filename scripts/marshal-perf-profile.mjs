#!/usr/bin/env node
/**
 * Performance profiling script for A/B comparison of the event pipeline.
 *
 * Connects to a running M instance via CDP (port 9222), sends a stress-test
 * prompt that triggers ~120 events at 20ms intervals, and captures:
 * custom event metrics, DevTools Tracing, and V8 CPU profiles.
 *
 * Usage:
 *   node scripts/marshal-perf-profile.mjs                        # defaults: 5 runs, port 9222
 *   node scripts/marshal-perf-profile.mjs --runs 3 --port 9223
 *   node scripts/marshal-perf-profile.mjs --output perf-main/    # custom output directory
 *
 * Prerequisites:
 *   pnpm build:vite && MARSHAL_E2E=1 pnpm electron:debug
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectToApp,
  evaluate,
  waitForReady,
  sendPrompt,
  waitForResponse,
  sleep,
  timestamp,
} from "../e2e-real/marshal-cdp-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { port: 9222, runs: 5, output: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) opts.port = parseInt(args[++i]);
    if (args[i] === "--runs" && args[i + 1]) opts.runs = parseInt(args[++i]);
    if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Instrumentation — injected into the renderer via CDP
// ---------------------------------------------------------------------------

const INSTALL_HOOKS = `
(() => {
  window.__perf = {
    events: [],
    mutations: [],
    firstEventAt: null,
    lastIdleAt: null,
    promptSentAt: null,
  };

  // Hook copilotAPI.onEvent for event timestamps
  if (!window.__perfHooked) {
    window.__perfHooked = true;
    window.copilotAPI.onEvent((wrapped) => {
      const now = performance.now();
      const type = wrapped?.event?.type || "unknown";
      window.__perf.events.push({ type, receivedAt: now });
      if (!window.__perf.firstEventAt) window.__perf.firstEventAt = now;
      if (type === "turn:idle" || type === "session.idle") {
        window.__perf.lastIdleAt = now;
      }
    });
  }

  // MutationObserver on chat-panel (stable wrapper that persists across
  // welcome-state → message-list transition). messages-container gets replaced
  // by React on first send, so observing it directly misses all mutations.
  if (window.__perfObserver) window.__perfObserver.disconnect();
  const panel = document.querySelector('[data-testid="chat-panel"]');
  if (panel) {
    window.__perfObserver = new MutationObserver(() => {
      window.__perf.mutations.push({ timestamp: performance.now() });
    });
    window.__perfObserver.observe(panel, { childList: true, subtree: true, characterData: true });
  }
})()
`;

const RESET_HOOKS = `
(() => {
  window.__perf.events = [];
  window.__perf.mutations = [];
  window.__perf.firstEventAt = null;
  window.__perf.lastIdleAt = null;
  window.__perf.promptSentAt = null;
})()
`;

const MARK_PROMPT_SENT = `
window.__perf.promptSentAt = performance.now()
`;

const COLLECT_METRICS = `
(() => {
  const p = window.__perf;
  if (!p) return null;

  // Find text-delta events (streaming content) and their corresponding DOM mutations
  const textEvents = p.events.filter(e =>
    e.type === "turn:text-delta" || e.type === "assistant.message_delta"
  );
  const firstTextEvent = textEvents[0] || null;

  // First DOM mutation after first text event = first content paint
  const firstMutationAfterText = firstTextEvent
    ? p.mutations.find(m => m.timestamp > firstTextEvent.receivedAt)
    : null;

  // Event-to-DOM latency: for each text event, find the next mutation
  const eventToDOM = [];
  for (const evt of textEvents) {
    const nextMutation = p.mutations.find(m => m.timestamp > evt.receivedAt);
    if (nextMutation) {
      eventToDOM.push(nextMutation.timestamp - evt.receivedAt);
    }
  }

  return {
    totalTurnMs: p.lastIdleAt && p.promptSentAt ? p.lastIdleAt - p.promptSentAt : null,
    firstContentPaintMs: firstMutationAfterText && firstTextEvent
      ? firstMutationAfterText.timestamp - firstTextEvent.receivedAt
      : null,
    eventCount: p.events.length,
    textEventCount: textEvents.length,
    mutationCount: p.mutations.length,
    avgEventToDOMMs: eventToDOM.length > 0
      ? eventToDOM.reduce((a, b) => a + b, 0) / eventToDOM.length
      : null,
    minEventToDOMMs: eventToDOM.length > 0 ? Math.min(...eventToDOM) : null,
    maxEventToDOMMs: eventToDOM.length > 0 ? Math.max(...eventToDOM) : null,
    eventTypes: p.events.map(e => e.type),
  };
})()
`;

// ---------------------------------------------------------------------------
// CDP Performance.getMetrics helper
// ---------------------------------------------------------------------------

async function getHeapSize(Performance) {
  const { metrics } = await Performance.getMetrics();
  const heap = metrics.find((m) => m.name === "JSHeapUsedSize");
  return heap ? heap.value : null;
}

// ---------------------------------------------------------------------------
// Main profiling loop
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const outputDir = opts.output || path.join(__dirname, "..", `perf-results-${timestamp()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`\n📊 M Performance Profiler (stress test — 20ms event intervals)`);
  console.log(`   Port: ${opts.port}`);
  console.log(`   Runs: ${opts.runs}`);
  console.log(`   Output: ${outputDir}\n`);

  // Connect to renderer
  console.log(`🔌 Connecting to M on port ${opts.port}...`);
  let connection;
  try {
    connection = await connectToApp(opts.port);
    console.log(`✅ Connected to: ${connection.target.title}\n`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    console.error(`   Make sure M is running with: MARSHAL_E2E=1 pnpm electron:debug\n`);
    process.exit(1);
  }

  const { client, Runtime } = connection;

  // Enable CDP domains
  const Performance = client.Performance;
  const Profiler = client.Profiler;
  const Tracing = client.Tracing;
  await Performance.enable();
  await Profiler.enable();
  await Profiler.setSamplingInterval({ interval: 100 }); // 100 microseconds

  // Wait for app ready
  await waitForReady(Runtime);
  console.log(`✅ App ready\n`);

  // Install hooks
  await evaluate(Runtime, INSTALL_HOOKS);

  const runs = [];

  for (let run = 1; run <= opts.runs; run++) {
    console.log(`━━━ Run ${run}/${opts.runs} ━━━`);

    // New session for each run (avoid cached context)
    if (run > 1) {
      await evaluate(Runtime, `document.querySelector('[data-testid="new-chat-btn"]')?.click()`);
      await sleep(2000);
      await waitForReady(Runtime);
      await evaluate(Runtime, INSTALL_HOOKS);
    }

    // Reset + re-attach observer right before send
    await evaluate(Runtime, RESET_HOOKS);
    await evaluate(Runtime, INSTALL_HOOKS);
    const heapBefore = await getHeapSize(Performance);

    // Start tracing + CPU profiler
    const traceChunks = [];
    const traceHandler = ({ value }) => {
      traceChunks.push(...value);
    };
    client.on("Tracing.dataCollected", traceHandler);

    await Tracing.start({
      categories:
        "devtools.timeline,v8.execute,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler",
      options: "sampling-frequency=10000", // 10kHz sampling
    });
    await Profiler.start();

    // Mark prompt sent + send stress scenario
    // "stress" keyword triggers MOCK_SCENARIO_STRESS (~120 events at 20ms intervals)
    await evaluate(Runtime, MARK_PROMPT_SENT);
    await sendPrompt(Runtime, "stress test the rendering pipeline");

    // Wait for response — stress scenario completes in ~3s
    await waitForResponse(Runtime, 3, 30);
    await sleep(500); // settle

    // Stop profilers
    const { profile } = await Profiler.stop();
    await Tracing.end();
    await sleep(500); // let trace data arrive

    // Collect metrics
    const heapAfter = await getHeapSize(Performance);
    const metrics = await evaluate(Runtime, COLLECT_METRICS);

    if (metrics) {
      metrics.heapBeforeBytes = heapBefore;
      metrics.heapAfterBytes = heapAfter;
      metrics.heapDeltaBytes = heapAfter && heapBefore ? heapAfter - heapBefore : null;
    }

    runs.push({ run, metrics });

    // Save trace
    const traceFile = path.join(outputDir, `trace-run-${run}.json`);
    fs.writeFileSync(traceFile, JSON.stringify(traceChunks));
    console.log(`   📄 Trace: ${traceFile}`);

    // Save CPU profile
    const profileFile = path.join(outputDir, `profile-run-${run}.cpuprofile`);
    fs.writeFileSync(profileFile, JSON.stringify(profile));
    console.log(`   📄 Profile: ${profileFile}`);

    // Print summary
    if (metrics) {
      const fmt = (v) => (v != null ? `${v.toFixed(1)}ms` : "n/a");
      console.log(`   Turn: ${fmt(metrics.totalTurnMs)}`);
      console.log(`   First paint: ${fmt(metrics.firstContentPaintMs)}`);
      console.log(`   Avg event→DOM: ${fmt(metrics.avgEventToDOMMs)}`);
      console.log(`   Events: ${metrics.eventCount}, Mutations: ${metrics.mutationCount}`);
      console.log(`   Heap: ${((metrics.heapDeltaBytes || 0) / 1024 / 1024).toFixed(2)} MB delta`);
    }
    console.log();

    // Clear trace listener for next run
    client.removeListener("Tracing.dataCollected", traceHandler);
  }

  // ---------------------------------------------------------------------------
  // Aggregate + save
  // ---------------------------------------------------------------------------

  const successful = runs.filter((r) => r.metrics);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const summary = {
    runs: opts.runs,
    successfulRuns: successful.length,
    detectedBranch: successful[0]?.metrics?.eventTypes?.[0]?.startsWith("turn:")
      ? "refactored"
      : "main",
    avgTotalTurnMs: avg(successful.map((r) => r.metrics.totalTurnMs).filter(Boolean)),
    avgFirstContentPaintMs: avg(
      successful.map((r) => r.metrics.firstContentPaintMs).filter(Boolean),
    ),
    avgEventToDOMMs: avg(successful.map((r) => r.metrics.avgEventToDOMMs).filter(Boolean)),
    avgEventCount: avg(successful.map((r) => r.metrics.eventCount)),
    avgMutationCount: avg(successful.map((r) => r.metrics.mutationCount)),
    avgHeapDeltaMB: avg(successful.map((r) => (r.metrics.heapDeltaBytes || 0) / 1024 / 1024)),
  };

  const report = {
    timestamp: new Date().toISOString(),
    summary,
    runs: runs.map((r) => ({ run: r.run, ...r.metrics })),
  };

  const metricsFile = path.join(outputDir, "metrics.json");
  fs.writeFileSync(metricsFile, JSON.stringify(report, null, 2));

  // Print summary table
  const hr = "─".repeat(50);
  console.log(hr);
  console.log(`Summary (${summary.successfulRuns}/${opts.runs} runs)`);
  console.log(`Branch: ${summary.detectedBranch}`);
  console.log(`Avg total turn:        ${summary.avgTotalTurnMs.toFixed(1)}ms`);
  console.log(`Avg first paint:       ${summary.avgFirstContentPaintMs.toFixed(1)}ms`);
  console.log(`Avg event→DOM:         ${summary.avgEventToDOMMs.toFixed(1)}ms`);
  console.log(`Avg events/turn:       ${summary.avgEventCount.toFixed(0)}`);
  console.log(`Avg mutations/turn:    ${summary.avgMutationCount.toFixed(0)}`);
  console.log(`Avg heap delta:        ${summary.avgHeapDeltaMB.toFixed(2)} MB`);
  console.log(hr);
  console.log(`\n📁 Results: ${outputDir}`);
  console.log(`   metrics.json — aggregate metrics`);
  console.log(`   trace-run-*.json — open in chrome://tracing`);
  console.log(`   profile-run-*.cpuprofile — open in DevTools Profiler\n`);

  await client.close();
}

main().catch((err) => {
  console.error(`\n💥 Profiler crashed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
