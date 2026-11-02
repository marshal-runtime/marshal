/**
 * Memory-leak soak + cancel-crash profiler for the Marshal harness.
 *
 * Connects to a running mock-mode instance via CDP (default port 9223) and:
 *  - MODE=soak  : repeatedly sends the "stress" scenario + churns sessions,
 *                 forcing GC and sampling renderer heap / DOM nodes / listeners
 *                 each cycle to detect monotonic growth (a leak).
 *  - MODE=cancel: sends a stress prompt then clicks the Stop button mid-stream,
 *                 repeatedly, watching for a process crash (CDP disconnect).
 *
 * Imports the existing CDP helper layer by absolute path so bare specifiers
 * (chrome-remote-interface) resolve against Q:\src\m\node_modules.
 */
import {
  connectToApp,
  evaluate,
  waitForReady,
  sendPrompt,
  waitForResponse,
  sleep,
} from "./cdp-helpers.mjs";
import fs from "node:fs";

const PORT = Number(process.env.PORT || 9223);
const CYCLES = Number(process.env.CYCLES || 20);
const MODE = process.env.MODE || "soak";
const OUT = process.env.OUT || "soak-results.json";

async function getMetrics(Performance) {
  const { metrics } = await Performance.getMetrics();
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function forceGC(client) {
  try {
    await client.HeapProfiler.collectGarbage();
  } catch {
    /* ignore */
  }
}

function linregSlope(ys) {
  const n = ys.length;
  const xs = ys.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

async function newChat(Runtime) {
  await evaluate(
    Runtime,
    `(() => {
      const b = document.querySelector('button[aria-label="New chat"]')
        || document.querySelector('[data-testid="new-chat-btn"]')
        || [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'New chat');
      if (b) { b.click(); return true; }
      return false;
    })()`,
  );
}

async function clickStop(Runtime) {
  return evaluate(
    Runtime,
    `(() => {
      const b = document.querySelector('[data-testid="stop-btn"]');
      if (b) { b.click(); return true; }
      return false;
    })()`,
  );
}

async function isAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`[soak] connecting to port ${PORT}, mode=${MODE}, cycles=${CYCLES}`);
  const conn = await connectToApp(PORT);
  const { client, Runtime } = conn;
  await client.Performance.enable();
  await client.HeapProfiler.enable();
  await waitForReady(Runtime);
  console.log(`[soak] connected + ready`);

  const samples = [];

  if (MODE === "cancel") {
    let crashed = false;
    for (let i = 0; i < CYCLES; i++) {
      if (!(await isAlive(PORT))) {
        console.log(`[cancel] ❌ process not alive before cycle ${i + 1} — CRASHED`);
        crashed = true;
        break;
      }
      try {
        await sendPrompt(Runtime, "stress test the rendering pipeline");
      } catch (err) {
        console.log(`[cancel] sendPrompt threw on cycle ${i + 1}: ${err.message}`);
        if (!(await isAlive(PORT))) {
          crashed = true;
          break;
        }
        continue;
      }
      // Cancel mid-stream at varied delays to hit different race windows
      await sleep(150 + (i % 5) * 120);
      let clicked = false;
      try {
        clicked = await clickStop(Runtime);
      } catch (err) {
        console.log(`[cancel] clickStop threw cycle ${i + 1}: ${err.message}`);
      }
      await sleep(600);
      const alive = await isAlive(PORT);
      console.log(`[cancel] cycle ${i + 1}: stopClicked=${clicked} aliveAfter=${alive}`);
      if (!alive) {
        console.log(`[cancel] ❌ CRASH reproduced on cycle ${i + 1}`);
        crashed = true;
        break;
      }
      // settle / let any late events flush, then ensure ready for next
      try {
        await waitForReady(Runtime, 10000);
      } catch {
        /* may be mid-teardown */
      }
      samples.push({ cycle: i + 1, stopClicked: clicked, alive });
    }
    fs.writeFileSync(OUT, JSON.stringify({ mode: "cancel", crashed, samples }, null, 2));
    console.log(`[cancel] done. crashed=${crashed}. wrote ${OUT}`);
    if (!crashed) await client.close();
    return;
  }

  // soak mode
  for (let i = 0; i < CYCLES; i++) {
    try {
      await sendPrompt(Runtime, "stress test the rendering pipeline");
      await waitForResponse(Runtime, 1, 30);
    } catch (err) {
      console.log(`[soak] cycle ${i + 1} send/response error: ${err.message}`);
    }
    await sleep(300);
    if (process.env.SAME_SESSION !== "1") {
      await newChat(Runtime);
      await sleep(1200);
      try {
        await waitForReady(Runtime, 15000);
      } catch (err) {
        console.log(`[soak] not ready after new chat cycle ${i + 1}: ${err.message}`);
      }
    } else {
      try {
        await waitForReady(Runtime, 15000);
      } catch (err) {
        console.log(`[soak] not ready (same-session) cycle ${i + 1}: ${err.message}`);
      }
    }
    // GC twice to settle finalizers
    await forceGC(client);
    await sleep(150);
    await forceGC(client);
    const m = await getMetrics(client.Performance);
    const dom = await evaluate(Runtime, `({nodes: document.querySelectorAll('*').length})`);
    const row = {
      cycle: i + 1,
      heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2),
      heapTotalMB: +(m.JSHeapTotalSize / 1048576).toFixed(2),
      domNodesMetric: m.Nodes,
      domNodesLive: dom.nodes,
      jsListeners: m.JSEventListeners,
      documents: m.Documents,
      contexts: m.JSContexts ?? m.V8CompileCacheSizeInBytes,
    };
    samples.push(row);
    console.log(
      `[soak] cycle ${row.cycle}: heap=${row.heapMB}MB domNodes=${row.domNodesMetric} live=${row.domNodesLive} listeners=${row.jsListeners} docs=${row.documents}`,
    );
  }

  // Drop the first 3 cycles as warm-up, compute slopes on the rest
  const stable = samples.slice(Math.min(3, samples.length - 1));
  const heapSlope = linregSlope(stable.map((s) => s.heapMB));
  const nodeSlope = linregSlope(stable.map((s) => s.domNodesMetric));
  const listenerSlope = linregSlope(stable.map((s) => s.jsListeners));
  const docSlope = linregSlope(stable.map((s) => s.documents));

  const summary = {
    mode: "soak",
    cycles: samples.length,
    heapMB_first: samples[0]?.heapMB,
    heapMB_last: samples.at(-1)?.heapMB,
    heapSlope_MBperCycle: +heapSlope.toFixed(4),
    domNodeSlope_perCycle: +nodeSlope.toFixed(3),
    listenerSlope_perCycle: +listenerSlope.toFixed(3),
    docSlope_perCycle: +docSlope.toFixed(3),
  };
  fs.writeFileSync(OUT, JSON.stringify({ summary, samples }, null, 2));
  console.log(`\n[soak] SUMMARY`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[soak] wrote ${OUT}`);
  await client.close();
}

main().catch((err) => {
  console.error(`[soak] crashed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
