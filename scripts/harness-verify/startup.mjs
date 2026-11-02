/**
 * Cold-start time-to-interactive profiler. Launches the fixed build in mock
 * mode N times, measuring from process spawn to:
 *  - CDP endpoint up
 *  - renderer page target present
 *  - chat-input-editor present AND enabled (interactive)
 * Reports per-run and median.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WORKTREE = process.env.WORKTREE || "Q:\\src\\m-perf-fix";
const RUNS = Number(process.env.RUNS || 3);
const BASE_PORT = Number(process.env.BASE_PORT || 9501);
const electron = path.join(WORKTREE, "node_modules", "electron", "dist", "electron.exe");

function now() { return Number(process.hrtime.bigint() / 1000000n); }
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch { return null; }
}

async function pollInteractive(port, t0, deadlineMs) {
  let cdpUp = null, pageUp = null, interactive = null;
  // Lazy import CDP from the worktree node_modules
  const CDP = (await import(`file:///${WORKTREE.replace(/\\/g, "/")}/node_modules/chrome-remote-interface/index.js`)).default;
  while (now() - t0 < deadlineMs) {
    if (!cdpUp) { const v = await fetchJson(`http://127.0.0.1:${port}/json/version`); if (v) cdpUp = now() - t0; }
    if (cdpUp && !pageUp) {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const pg = list?.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (pg) pageUp = now() - t0;
    }
    if (pageUp) {
      try {
        const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
        const pg = list.find((t) => t.type === "page" && t.url.includes("index.html"));
        const client = await CDP({ port, target: pg });
        await client.Runtime.enable();
        const res = await client.Runtime.evaluate({
          expression: `(() => {
            const ed = document.querySelector('[data-testid="chat-input-editor"]');
            return !!ed && ed.getAttribute('aria-disabled') !== 'true';
          })()`,
          returnByValue: true,
        });
        await client.close();
        if (res.result.value) { interactive = now() - t0; break; }
      } catch { /* not ready */ }
    }
    await sleep(100);
  }
  return { cdpUp, pageUp, interactive };
}

async function main() {
  const results = [];
  for (let i = 0; i < RUNS; i++) {
    const port = BASE_PORT + i;
    const udd = path.join(os.tmpdir(), `m-startup-udd-${port}`);
    fs.rmSync(udd, { recursive: true, force: true });
    fs.mkdirSync(udd, { recursive: true });
    const env = { ...process.env, MARSHAL_E2E: "1", ELECTRON_ENABLE_LOGGING: "1" };
    delete env.VITE_DEV_SERVER_URL;
    const t0 = now();
    const child = spawn(electron, [".", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`], {
      cwd: WORKTREE, env, stdio: "ignore", windowsHide: true,
    });
    const timings = await pollInteractive(port, t0, 30000);
    console.log(`run ${i + 1}: cdpUp=${timings.cdpUp}ms pageUp=${timings.pageUp}ms interactive=${timings.interactive}ms`);
    results.push(timings);
    try { child.kill(); } catch {}
    // also kill any electron children from this udd
    await sleep(1500);
  }
  const interactives = results.map((r) => r.interactive).filter((x) => x != null).sort((a, b) => a - b);
  const median = interactives[Math.floor(interactives.length / 2)];
  const summary = { runs: RUNS, interactiveMs: interactives, medianInteractiveMs: median };
  fs.writeFileSync(process.env.OUT || "startup.json", JSON.stringify({ summary, results }, null, 2));
  console.log("\nSUMMARY", JSON.stringify(summary));
}
main().catch((e) => { console.error(e); process.exit(1); });
