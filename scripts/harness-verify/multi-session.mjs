/**
 * Multi-session / "multiple agents" memory profile. Creates N chat sessions on
 * the fixed build, drives a stress turn in each, and samples renderer heap /
 * V8 nodes / listeners. Verifies memory stays bounded as session count grows
 * (no per-session renderer leak). Backend collection gauges are read separately
 * from the MARSHAL_LEAK_DIAG diagnostics jsonl.
 */
import { connectToApp, evaluate, sendPrompt, waitForResponse, sleep } from "file:///Q:/src/m-perf-fix/e2e-integration/cdp-helpers.mjs";
import fs from "node:fs";

const PORT = Number(process.env.PORT || 9240);
const SESSIONS = Number(process.env.SESSIONS || 12);
const OUT = process.env.OUT || "multi-session.json";

async function metrics(client) {
  const { metrics } = await client.Performance.getMetrics();
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}
async function gc(client) { try { await client.HeapProfiler.collectGarbage(); } catch {} }
function slope(ys) { const n=ys.length, xs=ys.map((_,i)=>i); const mx=xs.reduce((a,b)=>a+b,0)/n, my=ys.reduce((a,b)=>a+b,0)/n; let num=0,den=0; for(let i=0;i<n;i++){num+=(xs[i]-mx)*(ys[i]-my);den+=(xs[i]-mx)**2;} return den?num/den:0; }

async function newChat(Runtime) {
  return evaluate(Runtime, `(() => { const b=document.querySelector('[data-testid="new-chat-btn"]'); if (b) { b.click(); return true; } return false; })()`);
}
async function sessionCount(Runtime) {
  return evaluate(Runtime, `document.querySelectorAll('[data-testid="session-item"]').length`);
}

async function main() {
  const { client, Runtime } = await connectToApp(PORT);
  await client.Performance.enable();
  await client.HeapProfiler.enable();

  const samples = [];
  for (let i = 0; i < SESSIONS; i++) {
    await newChat(Runtime);
    await sleep(800);
    try {
      await sendPrompt(Runtime, "stress test the rendering pipeline");
      await waitForResponse(Runtime, 1, 25);
    } catch (e) {
      console.log(`session ${i+1} err: ${e.message.slice(0,90)}`);
    }
    await sleep(300);
    await gc(client); await sleep(120); await gc(client);
    const m = await metrics(client);
    const sc = await sessionCount(Runtime);
    const row = { session: i+1, sessionItems: sc, heapMB: +(m.JSHeapUsedSize/1048576).toFixed(2), nodes: m.Nodes, listeners: m.JSEventListeners, docs: m.Documents };
    samples.push(row);
    console.log(`[multi] session ${row.session}: items=${row.sessionItems} heap=${row.heapMB}MB nodes=${row.nodes} listeners=${row.listeners} docs=${row.docs}`);
  }
  const stable = samples.slice(Math.min(2, samples.length-1));
  const summary = {
    sessionsCreated: samples.length,
    heapSlope_MBperSession: +slope(stable.map(s=>s.heapMB)).toFixed(4),
    nodeSlope_perSession: +slope(stable.map(s=>s.nodes)).toFixed(2),
    listenerSlope_perSession: +slope(stable.map(s=>s.listeners)).toFixed(3),
    heapFirst: samples[0]?.heapMB, heapLast: samples.at(-1)?.heapMB,
    listenersFirst: samples[0]?.listeners, listenersLast: samples.at(-1)?.listeners,
  };
  fs.writeFileSync(OUT, JSON.stringify({ summary, samples }, null, 2));
  console.log("\n[multi] SUMMARY", JSON.stringify(summary, null, 2));
  await client.close();
}
main().catch((e) => { console.error(`harness error: ${e.message}`); process.exit(2); });
