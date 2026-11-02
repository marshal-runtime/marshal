/**
 * Real-streaming memory soak (NOT mock). Establishes a real session, then sends
 * N real prompts in the SAME session, sampling renderer heap / V8 Nodes /
 * JSEventListeners after forced GC each turn. Real markdown/code-block DOM is
 * much heavier than mock, so per-turn retention (the leak) shows clearly.
 */
import { connectToApp, evaluate, sendPrompt, waitForResponse, sleep } from "./cdp-helpers.mjs";
import fs from "node:fs";

const PORT = Number(process.env.PORT || 9402);
const CYCLES = Number(process.env.CYCLES || 12);
const OUT = process.env.OUT || "dev-soak.json";
const PROMPT = "Write a detailed 500-word technical explanation with several section headings, a bulleted list, and two short code blocks, about how a database query planner optimizes joins.";

async function metrics(client) {
  const { metrics } = await client.Performance.getMetrics();
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}
async function gc(client) { try { await client.HeapProfiler.collectGarbage(); } catch {} }
function slope(ys) { const n=ys.length, xs=ys.map((_,i)=>i); const mx=xs.reduce((a,b)=>a+b,0)/n, my=ys.reduce((a,b)=>a+b,0)/n; let num=0,den=0; for(let i=0;i<n;i++){num+=(xs[i]-mx)*(ys[i]-my);den+=(xs[i]-mx)**2;} return den?num/den:0; }

async function main() {
  const { client, Runtime } = await connectToApp(PORT);
  await client.Performance.enable();
  await client.HeapProfiler.enable();
  await evaluate(Runtime, `(() => { const b=document.querySelector('[data-testid="new-chat-btn"]'); if (b) b.click(); return !!b; })()`);
  await sleep(5000);

  const samples = [];
  for (let i = 0; i < CYCLES; i++) {
    try {
      await sendPrompt(Runtime, PROMPT);
      await waitForResponse(Runtime, 2, 60); // wait for real stream to finish
    } catch (e) {
      console.log(`[dev-soak] cycle ${i+1} err: ${e.message.slice(0,100)}`);
    }
    await sleep(400);
    await gc(client); await sleep(150); await gc(client);
    const m = await metrics(client);
    const dom = await evaluate(Runtime, `({ live: document.querySelectorAll('*').length, msgNodes: document.querySelectorAll('[data-testid="messages-container"] *').length })`);
    const row = { cycle: i+1, heapMB: +(m.JSHeapUsedSize/1048576).toFixed(2), nodes: m.Nodes, liveNodes: dom.live, msgNodes: dom.msgNodes, listeners: m.JSEventListeners };
    samples.push(row);
    console.log(`[dev-soak] cy ${row.cycle}: heap=${row.heapMB}MB nodes=${row.nodes} msgNodes=${row.msgNodes} listeners=${row.listeners}`);
  }
  const stable = samples.slice(Math.min(3, samples.length-1));
  const summary = {
    cycles: samples.length,
    heapSlope_MBper: +slope(stable.map(s=>s.heapMB)).toFixed(4),
    nodeSlope_per: +slope(stable.map(s=>s.nodes)).toFixed(2),
    msgNodeSlope_per: +slope(stable.map(s=>s.msgNodes)).toFixed(2),
    listenerSlope_per: +slope(stable.map(s=>s.listeners)).toFixed(3),
    heapFirst: samples[0]?.heapMB, heapLast: samples.at(-1)?.heapMB,
    listenersFirst: samples[0]?.listeners, listenersLast: samples.at(-1)?.listeners,
  };
  fs.writeFileSync(OUT, JSON.stringify({ summary, samples }, null, 2));
  console.log("\n[dev-soak] SUMMARY", JSON.stringify(summary, null, 2));
  await client.close();
}
main().catch((e) => { console.error(`harness error: ${e.message}`); process.exit(2); });
