import { execFile } from "child_process";

import { createLogger } from "../common/marshal-logger";

const log = createLogger("KeepAwake");

/**
 * Keeps Windows VMs awake by periodically injecting a mouse
 * input event via SendInput. Remote VMs detect inactivity via GetLastInputInfo,
 * which only tracks real input queue events — not programmatic cursor moves
 * like Cursor::Position. SendInput injects into the input queue and resets
 * the idle timer.
 *
 * Only active on Windows. No-ops silently on other platforms.
 */

const JIGGLE_INTERVAL_MS = 60 * 1000; // every 60 seconds

// PowerShell snippet: use SendInput via P/Invoke to inject a relative mouse
// move of (0,0). This is invisible to the user but registers as input,
// resetting GetLastInputInfo and preventing VM hibernation.
const PS_SEND_INPUT = `
$code = @'
using System;
using System.Runtime.InteropServices;
public class WakeUp {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public MOUSEINPUT mi;
  }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static void Move() {
    INPUT[] inp = new INPUT[1];
    inp[0].type = 0; // INPUT_MOUSE
    inp[0].mi.dwFlags = 0x0001; // MOUSEEVENTF_MOVE
    inp[0].mi.dx = 0;
    inp[0].mi.dy = 0;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
Add-Type -TypeDefinition $code
[WakeUp]::Move()
`.trim();

export class KeepAwakeManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private refs = new Set<string>();

  /**
   * Acquire a keep-awake hold for the given reason (e.g. "heartbeat", "relay").
   * The jiggle timer starts when the first hold is acquired.
   * Windows-only; no-ops on other platforms.
   */
  acquire(reason: string): void {
    if (process.platform !== "win32") return;
    this.refs.add(reason);
    if (!this.timer) {
      this.jiggle(); // immediate first jiggle
      this.timer = setInterval(() => this.jiggle(), JIGGLE_INTERVAL_MS);
      log.info(`Started — SendInput every 60s (reason: ${reason})`);
    } else {
      log.info(`Hold acquired: ${reason} (active: ${[...this.refs].join(", ")})`);
    }
  }

  /**
   * Release a keep-awake hold. The jiggle timer stops when all holds are released.
   */
  release(reason: string): void {
    this.refs.delete(reason);
    if (this.refs.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info(`Stopped (released: ${reason})`);
    } else if (this.timer) {
      log.info(`Hold released: ${reason} (remaining: ${[...this.refs].join(", ")})`);
    }
  }

  /** Check if the jiggle timer is active. */
  isActive(): boolean {
    return this.timer !== null;
  }

  /** Get active hold reasons. */
  activeReasons(): string[] {
    return [...this.refs];
  }

  /** Clean shutdown. */
  destroy(): void {
    this.refs.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private jiggle(): void {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PS_SEND_INPUT],
      { windowsHide: true, timeout: 10000 },
      (err, _stdout, stderr) => {
        if (err) {
          const code = "code" in err ? err.code : undefined;
          if (code === "ENOENT") {
            log.warn("powershell.exe not found on PATH");
          } else if (code === "EACCES") {
            log.warn("Permission denied running powershell.exe");
          } else {
            log.warn(`Mouse jiggle failed (${code ?? "exit"}):`, err.message);
          }
        } else if (stderr) {
          const msg = stderr.trim();
          if (msg) log.warn("PowerShell stderr:", msg);
        }
      },
    );
  }
}
