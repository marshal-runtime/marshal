// Marshal-owned test
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// Source-level pin for the applyShellPathFix wiring. `main.ts` is too
// entangled to import standalone in a unit test (1700+ LOC, side-effecty
// top-level — Electron window creation, IPC registration, SDK init, ...),
// so this test reads `main.ts` as text and asserts:
//
//   1. `applyShellPathFix` is imported from `./fix-path`.
//   2. It is called exactly once at module scope.
//   3. The call appears BEFORE any other side-effecting startup statements
//      that could spawn a child process or trigger downstream module init
//      (`app.whenReady`, `createWindow`, IPC handler registration, the
//      session manager).
//
// If a future refactor deletes the call, moves it into a callback, or
// reorders it after the boot machinery, this test fails — even though the
// fix-path module itself still works.
//
// Why a source-level test rather than `bootElectronApp()` extraction:
// extracting startup into an exported helper is a much broader change than
// the original one-line wiring. We pick this lighter fence post until the
// helper exists.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_TS = path.join(__dirname, "main.ts");

function loadMainSource(): string {
  return readFileSync(MAIN_TS, "utf8");
}

function indexOfMatch(source: string, pattern: RegExp): number {
  const m = pattern.exec(source);
  return m ? m.index : -1;
}

describe("main.ts wiring for applyShellPathFix", () => {
  const source = loadMainSource();

  it("imports applyShellPathFix from ./fix-path", () => {
    expect(source).toMatch(/import\s*\{\s*applyShellPathFix\s*\}\s*from\s*["']\.\/fix-path["']/);
  });

  it("calls applyShellPathFix exactly once", () => {
    const calls = source.match(/^\s*applyShellPathFix\s*\(\s*\)\s*;?\s*$/gm) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("calls applyShellPathFix before app.whenReady, createWindow, and SessionManager init", () => {
    const callIdx = indexOfMatch(source, /^\s*applyShellPathFix\s*\(/m);
    expect(callIdx).toBeGreaterThan(-1);

    // Sentinel statements that, once reached, mean we've passed the safe
    // window for setting process.env.PATH. Any one of these executing
    // before applyShellPathFix() would regress the GUI-launch PATH fix.
    const sentinels = [
      { name: "app.whenReady", pattern: /\bapp\.whenReady\s*\(/ },
      { name: "createWindow", pattern: /\bcreateWindow\s*\(/ },
      { name: "new SessionManager", pattern: /\bnew\s+SessionManager\b/ },
    ];

    for (const { name, pattern } of sentinels) {
      const sentinelIdx = indexOfMatch(source, pattern);
      if (sentinelIdx === -1) continue; // sentinel removed in a refactor — fine
      expect(callIdx < sentinelIdx, `applyShellPathFix() must be called before ${name}`).toBe(true);
    }
  });
});
