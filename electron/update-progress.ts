/**
 * Windows-only: spawns a batch script that waits for the current Electron
 * process to fully exit, then runs the NSIS installer silently.
 *
 * Uses a .bat file (never blocked by execution policies) with an optional
 * PowerShell progress dialog launched as best-effort.
 *
 * This bridges the visual gap between app close and app relaunch, and avoids
 * the "Failed to uninstall old application files" error caused by NSIS
 * starting while files are still locked.
 */

import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { APP_NAME } from "../common/marshal-constants";

function debugLog(msg: string): void {
  const logFile = join(tmpdir(), "marshal-update", "update-debug.log");
  try {
    appendFileSync(logFile, `${new Date().toISOString()} [Node] ${msg}\n`);
  } catch {
    /* best effort */
  }
}

/**
 * Generate a .bat script that:
 * 1. Writes a ready signal file (so Node.js knows the script is alive)
 * 2. Waits for the Electron process (by PID) to fully exit
 * 3. Optionally launches a PowerShell progress dialog (best effort)
 * 4. Runs the NSIS installer silently
 * 5. Kills the progress dialog after the installer finishes
 */
/** Reject paths containing characters that would break bat double-quoting. */
function assertSafeBatPath(p: string, label: string): void {
  if (/["%^&|<>]/.test(p)) {
    throw new Error(`Unsafe characters in ${label}: ${p}`);
  }
}

export function generateBatScript(
  installerPath: string,
  pid: number,
  readySignalPath: string,
  appExePath: string,
): string {
  assertSafeBatPath(installerPath, "installerPath");
  assertSafeBatPath(appExePath, "appExePath");
  // appExePath only appears in BAT double-quoted context where ' is harmless; installerPath is also embedded in a PS single-quoted string
  const psEscapedPath = installerPath.replace(/'/g, "''");
  const logPath = join(tmpdir(), "marshal-update", "update-debug.log");
  // Unique nonce in the window title so taskkill only targets our dialog,
  // not any other PowerShell window the user might have open.
  const nonce = randomBytes(4).toString("hex");
  const dialogTitle = `Updating ${APP_NAME} ${nonce}`;
  // PowerShell one-liner for a simple dialog (best-effort, runs in background).
  // No progress bar — just a clean centered message.
  const psDialog = [
    `Add-Type -AssemblyName System.Windows.Forms`,
    `$f=New-Object System.Windows.Forms.Form`,
    `$f.Text='${dialogTitle}'`,
    `$f.Size='420,130'`,
    `$f.StartPosition='CenterScreen'`,
    `$f.FormBorderStyle='FixedDialog'`,
    `$f.MaximizeBox=$false`,
    `$f.MinimizeBox=$false`,
    `$f.TopMost=$true`,
    `$f.ShowInTaskbar=$true`,
    `$l=New-Object System.Windows.Forms.Label`,
    `$l.Text='Installing update, please wait...'`,
    `$l.Size='380,25'`,
    `$l.Location='20,20'`,
    `$l.Font=New-Object System.Drawing.Font('Segoe UI',10)`,
    `$f.Controls.Add($l)`,
    `$l2=New-Object System.Windows.Forms.Label`,
    `$l2.Text='This may take a minute.'`,
    `$l2.Size='380,20'`,
    `$l2.Location='20,50'`,
    `$l2.ForeColor=[System.Drawing.Color]::Gray`,
    `$l2.Font=New-Object System.Drawing.Font('Segoe UI',9)`,
    `$f.Controls.Add($l2)`,
    `$f.ShowDialog()`,
  ].join("; ");

  const verifyLines = [
    `rem Re-verify Authenticode signature before launching. Fail-closed on a missing`,
    `rem powershell.exe — Node-side verifyWindowsSignature already required it, so its`,
    `rem absence here is anomalous and we'd rather skip the update than launch unverified.`,
    `rem Two hardening details, both required because this bat is a detached process spawned via`,
    `rem wscript with stdio:"ignore" (no console, NUL std handles):`,
    `rem  1. Pin the Windows PowerShell system module path. powershell.exe (5.1) must load the built-in`,
    `rem     Microsoft.PowerShell.Security; an incompatible inherited PSModulePath (e.g. one ordering`,
    `rem     PowerShell 7's module dirs first) makes the re-verify cmdlet resolve to an unloadable build,`,
    `rem     so the check fails closed and silently blocks every update. Replace with the system dirs.`,
    `rem  2. Run powershell with -NonInteractive -InputFormat None and stdin from NUL. With the inherited`,
    `rem     NUL stdin, powershell.exe otherwise aborts before running the command, killing the bat`,
    `rem     right here — before the installer ever launches.`,
    `set "PSModulePath=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\Modules;%ProgramFiles%\\WindowsPowerShell\\Modules"`,
    `where powershell >nul 2>&1`,
    `rem Keep echo text inside the following if-block free of parentheses: an unescaped close-paren`,
    `rem ends the block early, a cmd parse error that silently aborts the bat before the installer runs.`,
    `if errorlevel 1 (`,
    `    >> "${logPath}" echo %date% %time% [BAT] powershell.exe not found - aborting, cannot re-verify signature`,
    `    exit /B 1`,
    `)`,
    `>> "${logPath}" echo %date% %time% [BAT] Re-verifying signature...`,
    `powershell -NoProfile -NonInteractive -InputFormat None -Command "$sig = Get-AuthenticodeSignature '${psEscapedPath}'; if ($sig.Status -ne 'Valid') { exit 1 }" < nul >nul 2>&1`,
    `if errorlevel 1 (`,
    `    >> "${logPath}" echo %date% %time% [BAT] Signature re-verification FAILED - aborting`,
    `    exit /B 1`,
    `)`,
    `>> "${logPath}" echo %date% %time% [BAT] Signature re-verified OK`,
  ];

  return [
    `@echo off`,
    ``,
    `>> "${logPath}" echo %date% %time% [BAT] Script started, waiting for PID ${pid}`,
    ``,
    `rem Signal to the parent process that we are alive`,
    `echo ready> "${readySignalPath}"`,
    ``,
    `rem Wait for Electron to fully exit`,
    `:waitloop`,
    `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul`,
    `if not errorlevel 1 (`,
    `    timeout /t 1 /nobreak >nul`,
    `    goto waitloop`,
    `)`,
    `>> "${logPath}" echo %date% %time% [BAT] Process exited`,
    ``,
    `rem Extra buffer for file handles to release`,
    `timeout /t 2 /nobreak >nul`,
    ``,
    ...verifyLines,
    ``,
    `rem Try to show progress dialog via PowerShell (best effort, non-blocking)`,
    `start "" /B powershell -WindowStyle Hidden -ExecutionPolicy Bypass -Command "${psDialog}" 2>nul`,
    `>> "${logPath}" echo %date% %time% [BAT] Starting installer: ${installerPath}`,
    ``,
    `rem Run NSIS installer silently and wait for it to finish`,
    `start "" /wait "${installerPath}" /S`,
    `>> "${logPath}" echo %date% %time% [BAT] Installer finished`,
    ``,
    `rem Kill the progress dialog if still open`,
    `taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq ${dialogTitle}" 2>nul`,
    ``,
    `rem Relaunch the app (NSIS with oneClick:false + /S doesn't auto-launch)`,
    `>> "${logPath}" echo %date% %time% [BAT] Relaunching app`,
    `start "" "${appExePath}"`,
    `>> "${logPath}" echo %date% %time% [BAT] Done`,
  ].join("\r\n");
}

/**
 * Wait for a file to appear on disk. Returns true if found, false on timeout.
 */
function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(filePath)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  });
}

/**
 * Write the update wrapper .bat script to temp and spawn it detached.
 * Waits for the script to signal it's alive before returning.
 * Call this right before `app.exit(0)`.
 */
export async function spawnUpdateProgress(
  installerPath: string,
  appExePath: string,
): Promise<boolean> {
  const dir = join(tmpdir(), "marshal-update");
  mkdirSync(dir, { recursive: true });

  const readySignal = join(dir, "update-ready.signal");
  try {
    rmSync(readySignal);
  } catch {
    /* may not exist */
  }

  // Sweep launcher debris from prior update attempts. Each run writes a fresh
  // nonce-named pair; without this, %TEMP%\marshal-update\ accumulates files until
  // the OS gets around to cleaning it.
  try {
    for (const f of readdirSync(dir)) {
      if (/^update-(wrapper|launcher)-[0-9a-f]{8}\.(bat|vbs)$/.test(f)) {
        try {
          rmSync(join(dir, f));
        } catch {
          /* may not exist */
        }
      }
    }
  } catch {
    /* dir may not exist */
  }

  debugLog(`spawnUpdateProgress called. installerPath=${installerPath}, pid=${process.pid}`);

  const nonce = randomBytes(4).toString("hex");
  const batPath = join(dir, `update-wrapper-${nonce}.bat`);
  const script = generateBatScript(installerPath, process.pid, readySignal, appExePath);
  writeFileSync(batPath, script, "utf-8");

  // Use a VBS launcher to run the bat file in a completely hidden window.
  // On Windows, `detached: true` forces a visible console even with `windowsHide`.
  // WScript is a GUI host — its Run method with 0 hides the child cmd window.
  const vbsPath = join(dir, `update-launcher-${nonce}.vbs`);
  writeFileSync(
    vbsPath,
    `CreateObject("WScript.Shell").Run "cmd /C """ & WScript.Arguments(0) & """", 0, False`,
  );
  debugLog(`Scripts written: bat=${batPath}, vbs=${vbsPath}`);

  const child = spawn("wscript", [vbsPath, batPath], {
    detached: true,
    stdio: "ignore",
  });
  debugLog(`wscript spawned, child.pid=${child.pid}`);
  child.on("error", (err) => {
    debugLog(`wscript spawn error: ${err.message}. Falling back to direct cmd.`);
    // Fallback: spawn cmd directly (will show a console window but at least runs)
    spawn("cmd", ["/C", batPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  });
  child.unref();

  // Wait for the bat script to signal it's alive before we let the caller exit
  const ready = await waitForFile(readySignal, 10_000);
  debugLog(ready ? "Bat script signaled ready" : "Timed out waiting for bat script signal");
  return ready;
}
