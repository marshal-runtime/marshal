import { spawn } from "child_process";
import { readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { generateBatScript, spawnUpdateProgress } from "./update-progress";

vi.mock("child_process", () => ({
  spawn: vi.fn<
    (...args: unknown[]) => { unref: () => void; on: (event: string, cb: () => void) => void }
  >(() => ({ unref: vi.fn<() => void>(), on: vi.fn<(event: string, cb: () => void) => void>() })),
}));

const updateDir = join(tmpdir(), "marshal-update");
const signalPath = join(updateDir, "update-ready.signal");
const appExe = "C:\\Program Files\\Marshal\\Marshal.exe";

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(signalPath);
  } catch {
    /* may not exist */
  }
  try {
    for (const f of readdirSync(updateDir)) {
      if (/^update-(wrapper|launcher)-[0-9a-f]{8}\.(bat|vbs)$/.test(f)) {
        try {
          rmSync(join(updateDir, f));
        } catch {
          /* may not exist */
        }
      }
    }
  } catch {
    /* dir may not exist */
  }
});

describe("generateBatScript", () => {
  it("embeds installer path, PID, signal path, and app exe", () => {
    const script = generateBatScript("C:\\tmp\\marshal-update\\Setup.exe", 12345, signalPath, appExe);
    expect(script).toContain("PID eq 12345");
    expect(script).toContain("C:\\tmp\\marshal-update\\Setup.exe");
    expect(script).toContain("/S");
    expect(script).toContain("update-ready.signal");
    expect(script).toContain("Marshal.exe");
  });

  it("relaunches app after installer finishes", () => {
    const script = generateBatScript("C:\\tmp\\Setup.exe", 1, signalPath, appExe);
    const lines = script.split("\r\n");
    const installerIdx = lines.findIndex((l) => l.includes("/S"));
    const relaunchIdx = lines.findIndex((l) => l.includes(`start "" "${appExe}"`));
    expect(relaunchIdx).toBeGreaterThan(installerIdx);
  });

  it("includes PowerShell dialog without progress bar", () => {
    const script = generateBatScript("C:\\tmp\\Setup.exe", 1, signalPath, appExe);
    expect(script).toContain("powershell");
    expect(script).toContain("Installing update, please wait...");
    expect(script).toContain("This may take a minute.");
    expect(script).not.toContain("Marquee");
  });

  it("uses CRLF line endings", () => {
    const script = generateBatScript("C:\\tmp\\Setup.exe", 1, signalPath, appExe);
    expect(script).toContain("\r\n");
  });

  it("includes Authenticode re-verification before installer launch", () => {
    const script = generateBatScript("C:\\tmp\\marshal-update\\Setup.exe", 1, signalPath, appExe);
    expect(script).toContain("Get-AuthenticodeSignature '");
    expect(script).toContain("$sig.Status -ne 'Valid'");
    expect(script).toContain("exit /B 1");
    expect(script).toContain("[BAT] Signature re-verification FAILED - aborting");
  });

  it("pins the system PSModulePath before the re-verify (detached bat must load Get-AuthenticodeSignature)", () => {
    const script = generateBatScript("C:\\tmp\\marshal-update\\Setup.exe", 1, signalPath, appExe);
    expect(script).toContain("WindowsPowerShell\\v1.0\\Modules");
    const lines = script.split("\r\n");
    const setIdx = lines.findIndex((l) => l.startsWith('set "PSModulePath='));
    const verifyIdx = lines.findIndex((l) => l.includes("Get-AuthenticodeSignature"));
    expect(setIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(setIdx);
  });

  it("runs the re-verify with NUL stdin + non-interactive flags (detached wscript/stdio:ignore context)", () => {
    const script = generateBatScript("C:\\tmp\\marshal-update\\Setup.exe", 1, signalPath, appExe);
    const verifyLine = script
      .split("\r\n")
      .find((l) => l.startsWith("powershell") && l.includes("Get-AuthenticodeSignature"));
    expect(verifyLine).toBeDefined();
    expect(verifyLine).toContain("-NonInteractive");
    expect(verifyLine).toContain("-InputFormat None");
    expect(verifyLine).toContain("< nul");
  });

  it("escapes single quotes in installer path for PowerShell", () => {
    const script = generateBatScript("C:\\it's\\marshal-update\\Setup.exe", 1, signalPath, appExe);
    expect(script).toContain("Get-AuthenticodeSignature 'C:\\it''s\\marshal-update\\Setup.exe'");
  });

  it("re-verify block appears after buffer timeout and before installer launch", () => {
    const script = generateBatScript("C:\\tmp\\Setup.exe", 1, signalPath, appExe);
    const lines = script.split("\r\n");
    const bufferIdx = lines.findIndex((l) => l.includes("timeout /t 2"));
    const verifyIdx = lines.findIndex((l) => l.includes("Get-AuthenticodeSignature"));
    const launchIdx = lines.findIndex((l) => l.includes('start "" /wait'));
    expect(verifyIdx).toBeGreaterThan(bufferIdx);
    expect(launchIdx).toBeGreaterThan(verifyIdx);
  });

  it("fail-closed when powershell.exe is not available", () => {
    const script = generateBatScript("C:\\tmp\\Setup.exe", 1, signalPath, appExe);
    expect(script).toContain("where powershell >nul 2>&1");
    expect(script).toContain(
      "[BAT] powershell.exe not found - aborting, cannot re-verify signature",
    );
    // Regression guard: NO parentheses in echo text inside the if-block — an unescaped close-paren
    // closes the cmd ( ) block early, a parse error that silently aborts the bat before install.
    expect(script).not.toContain("aborting (cannot");
    expect(script).not.toContain("goto launch");
    expect(script).not.toContain("skipping re-verify");
    const lines = script.split("\r\n");
    const missingPsLogIdx = lines.findIndex((l) =>
      l.includes("powershell.exe not found - aborting"),
    );
    const installerIdx = lines.findIndex((l) => l.includes('start "" /wait'));
    expect(missingPsLogIdx).toBeGreaterThan(-1);
    expect(installerIdx).toBeGreaterThan(missingPsLogIdx);
    const exitLine = lines
      .slice(missingPsLogIdx, installerIdx)
      .find((l) => l.includes("exit /B 1"));
    expect(exitLine).toBeDefined();
  });
});

describe("spawnUpdateProgress", () => {
  it("writes nonce-named bat and vbs and spawns via wscript", async () => {
    setTimeout(() => writeFileSync(signalPath, "ready"), 100);

    const ready = await spawnUpdateProgress("C:\\tmp\\marshal-update\\Setup.exe", appExe);

    expect(ready).toBe(true);

    const call = vi.mocked(spawn).mock.calls[0];
    expect(call[0]).toBe("wscript");
    expect(call[1][0]).toMatch(/update-launcher-[0-9a-f]{8}\.vbs$/);
    expect(call[1][1]).toMatch(/update-wrapper-[0-9a-f]{8}\.bat$/);
  });

  it("returns false if signal never arrives", async () => {
    const ready = await spawnUpdateProgress("C:\\tmp\\marshal-update\\Setup.exe", appExe);
    expect(ready).toBe(false);
  }, 15_000);

  it("sweeps launcher debris from prior update attempts", async () => {
    // Seed the dir with debris-shaped files (both shapes that match the production regex)
    // and one file that should NOT be touched (different prefix).
    const stale1 = join(updateDir, "update-wrapper-deadbeef.bat");
    const stale2 = join(updateDir, "update-launcher-cafebabe.vbs");
    const keep = join(updateDir, "update-debug.log");
    writeFileSync(stale1, "stale");
    writeFileSync(stale2, "stale");
    writeFileSync(keep, "log");

    setTimeout(() => writeFileSync(signalPath, "ready"), 100);
    await spawnUpdateProgress("C:\\tmp\\marshal-update\\Setup.exe", appExe);

    const remaining = readdirSync(updateDir);
    expect(remaining).not.toContain("update-wrapper-deadbeef.bat");
    expect(remaining).not.toContain("update-launcher-cafebabe.vbs");
    expect(remaining).toContain("update-debug.log");
  });

  it("registers error handler", async () => {
    setTimeout(() => writeFileSync(signalPath, "ready"), 50);
    await spawnUpdateProgress("C:\\tmp\\marshal-update\\Setup.exe", appExe);

    const mockChild = vi.mocked(spawn).mock.results[0].value;
    expect(mockChild.on).toHaveBeenCalledWith("error", expect.any(Function));
  });
});
