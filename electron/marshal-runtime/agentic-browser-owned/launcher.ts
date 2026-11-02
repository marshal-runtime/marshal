import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Browser detection
// ---------------------------------------------------------------------------

interface BrowserInfo {
  path: string;
  browser: "chrome" | "edge";
  profileDir: string;
}

const CHROME_PATHS_WIN = [
  join(
    process.env["PROGRAMFILES"] ?? "C:\\Program Files",
    "Google",
    "Chrome",
    "Application",
    "chrome.exe",
  ),
  join(
    process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
    "Google",
    "Chrome",
    "Application",
    "chrome.exe",
  ),
  join(process.env["LOCALAPPDATA"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
];

const EDGE_PATHS_WIN = [
  join(
    process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
    "Microsoft",
    "Edge",
    "Application",
    "msedge.exe",
  ),
  join(
    process.env["PROGRAMFILES"] ?? "C:\\Program Files",
    "Microsoft",
    "Edge",
    "Application",
    "msedge.exe",
  ),
];

const CHROME_PATHS_MAC = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ...chromeForTestingPathsMac(),
];

const EDGE_PATHS_MAC = ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];

const CHROME_PATHS_LINUX = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

const EDGE_PATHS_LINUX = ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"];

function chromeForTestingPathsMac(): string[] {
  const cacheRoot = join(homedir(), "Library", "Caches", "ms-playwright");
  try {
    return readdirSync(cacheRoot)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((name) =>
        join(
          cacheRoot,
          name,
          process.arch === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64",
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ),
      );
  } catch {
    return [];
  }
}

function getUserDataDir(browser: "chrome" | "edge"): string {
  const platform = process.platform;
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const localAppData = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");

  if (platform === "win32") {
    return browser === "chrome"
      ? join(localAppData, "Google", "Chrome", "User Data")
      : join(localAppData, "Microsoft", "Edge", "User Data");
  }
  if (platform === "darwin") {
    return browser === "chrome"
      ? join(home, "Library", "Application Support", "Google", "Chrome")
      : join(home, "Library", "Application Support", "Microsoft Edge");
  }
  // Linux
  return browser === "chrome"
    ? join(home, ".config", "google-chrome")
    : join(home, ".config", "microsoft-edge");
}

function findBrowser(preferred?: "chrome" | "edge"): BrowserInfo | null {
  const platform = process.platform;

  const searchOrder: Array<{ paths: string[]; browser: "chrome" | "edge" }> =
    preferred === "edge"
      ? [
          { paths: getPaths("edge", platform), browser: "edge" },
          { paths: getPaths("chrome", platform), browser: "chrome" },
        ]
      : [
          { paths: getPaths("chrome", platform), browser: "chrome" },
          { paths: getPaths("edge", platform), browser: "edge" },
        ];

  for (const { paths, browser } of searchOrder) {
    for (const p of paths) {
      if (existsSync(p)) {
        return { path: p, browser, profileDir: getUserDataDir(browser) };
      }
    }
  }

  return null;
}

function getPaths(browser: "chrome" | "edge", platform: string): string[] {
  if (platform === "win32") {
    return browser === "chrome" ? CHROME_PATHS_WIN : EDGE_PATHS_WIN;
  }
  if (platform === "darwin") {
    return browser === "chrome" ? CHROME_PATHS_MAC : EDGE_PATHS_MAC;
  }
  return browser === "chrome" ? CHROME_PATHS_LINUX : EDGE_PATHS_LINUX;
}

// ---------------------------------------------------------------------------
// Port availability
// ---------------------------------------------------------------------------

async function isPortInUse(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Browser launcher
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  browser?: "chrome" | "edge";
  port?: number;
  profile?: string;
  headless?: boolean;
  expose?: boolean;
  userDataDir?: string;
  seedUserDataDir?: string;
}

export interface LaunchResult {
  port: number;
  browser: "chrome" | "edge";
  profileDir: string;
  wsUrl: string;
}

export async function launchBrowser(options: LaunchOptions = {}): Promise<LaunchResult> {
  const port = options.port ?? 9222;

  // Check if a browser is already running on this port
  if (await isPortInUse(port)) {
    process.stderr.write(`Browser already running on port ${String(port)}, connecting...\n`);
    const version = await getBrowserVersion(port);
    const browser = version.Browser?.includes("Edg") ? ("edge" as const) : ("chrome" as const);
    saveConfig({ port, browser });
    return {
      port,
      browser,
      profileDir: getUserDataDir(browser),
      wsUrl: version.webSocketDebuggerUrl ?? `ws://127.0.0.1:${String(port)}`,
    };
  }

  // Find browser binary — try preferred first, then fall back to the other
  const preferred = options.browser;
  const info = findBrowser(preferred);
  const altBrowser: "chrome" | "edge" = preferred === "edge" ? "chrome" : "edge";
  const infoAlt = findBrowser(altBrowser);

  if (!info && !infoAlt) {
    throw new Error(
      "Could not find Chrome or Edge. Install Chrome or Edge, or specify the path manually.",
    );
  }

  if (info && options.userDataDir) {
    seedProfile(options.userDataDir, options.seedUserDataDir, options.profile);
    const result = await tryLaunch(info, port, options, options.userDataDir);
    if (result) return result;
    throw new Error("Agentic Browser could not start its Marshal-owned Chrome profile.");
  }

  // Try launching with the primary profile first.
  // If the profile is locked (browser already running with it), fall back to:
  // 1. The other browser (Edge if Chrome is locked, or vice versa)
  // 2. A temporary profile (copies cookies for auth access)
  const attempts: Array<{ info: BrowserInfo; tempProfile?: string; label: string }> = [];

  if (info) {
    attempts.push({ info, label: `${info.browser} (user profile)` });
  }
  if (infoAlt && infoAlt.browser !== info?.browser) {
    attempts.push({ info: infoAlt, label: `${infoAlt.browser} (user profile)` });
  }
  if (info) {
    const tempDir = join(tmpdir(), `agentic-browser-${info.browser}-${String(port)}`);
    attempts.push({ info, tempProfile: tempDir, label: `${info.browser} (temp profile)` });
  }

  for (const attempt of attempts) {
    // eslint-disable-next-line no-await-in-loop -- fallbacks must run in priority order and stop after the first successful launch
    const result = await tryLaunch(attempt.info, port, options, attempt.tempProfile);
    if (result) {
      return result;
    }
    process.stderr.write(`Could not start ${attempt.label}, trying next option...\n`);
  }

  throw new Error(
    "Browser did not start. If a browser is already running with the same profile, " +
      "close it first and retry, or use --browser edge/chrome to try the other browser.",
  );
}

function seedProfile(destinationRoot: string, sourceRoot?: string, profile = "Default"): void {
  if (!sourceRoot || existsSync(join(destinationRoot, "Local State"))) return;
  const sourceProfile = join(sourceRoot, profile);
  const destinationProfile = join(destinationRoot, profile);
  mkdirSync(destinationProfile, { recursive: true });
  for (const file of ["Cookies", "Login Data", "Web Data", "Preferences", "Secure Preferences"]) {
    try {
      const source = join(sourceProfile, file);
      if (existsSync(source)) cpSync(source, join(destinationProfile, file), { force: true });
    } catch {
      // Authentication migration is best effort; the owned profile remains usable.
    }
  }
  try {
    cpSync(join(sourceRoot, "Local State"), join(destinationRoot, "Local State"), { force: true });
  } catch {
    // A fresh Local State file will be created by Chrome.
  }
}

async function tryLaunch(
  info: BrowserInfo,
  port: number,
  options: LaunchOptions,
  tempProfileDir?: string,
): Promise<LaunchResult | null> {
  process.stderr.write(`Found ${info.browser} at: ${info.path}\n`);

  const args: string[] = [
    `--remote-debugging-port=${String(port)}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  // Bind to all interfaces so remote agents can connect
  if (options.expose) {
    args.push("--remote-debugging-address=0.0.0.0");
    // Allow any origin when intentionally exposed
    args.push("--remote-allow-origins=*");
    process.stderr.write(
      "\n⚠️  SECURITY WARNING: --expose binds CDP to 0.0.0.0 (all interfaces).\n" +
        "   Anyone on your network can fully control this browser.\n" +
        "   The connection is unencrypted (plain HTTP/WebSocket).\n" +
        "\n" +
        "   For secure remote access, use SSH tunneling instead:\n" +
        "     1. Run setup WITHOUT --expose (default, localhost only)\n" +
        "     2. On the agent machine: ssh -L 9222:127.0.0.1:9222 user@this-pc\n" +
        "     3. Then: agentic-browser connect --host 127.0.0.1 --port 9222\n" +
        "\n" +
        "   Only use --expose on trusted private networks.\n\n",
    );
  } else {
    // Localhost only — restrict origins to localhost
    args.push("--remote-allow-origins=http://127.0.0.1:*,ws://127.0.0.1:*");
  }

  let profileDir = info.profileDir;

  if (tempProfileDir) {
    // Create a temp profile and copy cookies from the real profile
    mkdirSync(tempProfileDir, { recursive: true });
    const profileSubDir = options.profile ?? "Default";
    const sourceProfile = join(info.profileDir, profileSubDir);
    const destProfile = join(tempProfileDir, profileSubDir);

    // Copy Cookies and Login Data for auth (best-effort)
    const filesToCopy = ["Cookies", "Login Data", "Web Data", "Preferences", "Secure Preferences"];
    if (existsSync(sourceProfile)) {
      mkdirSync(destProfile, { recursive: true });
      for (const file of filesToCopy) {
        const src = join(sourceProfile, file);
        const dst = join(destProfile, file);
        try {
          if (existsSync(src)) cpSync(src, dst, { force: true });
        } catch {
          // Best-effort: some files may be locked
        }
      }
      // Also copy Local State from the root
      const localState = join(info.profileDir, "Local State");
      const localStateDst = join(tempProfileDir, "Local State");
      try {
        if (existsSync(localState)) cpSync(localState, localStateDst, { force: true });
      } catch {
        /* ignore */
      }
    }

    args.push(`--user-data-dir=${tempProfileDir}`);
    if (options.profile) {
      args.push(`--profile-directory=${options.profile}`);
    }
    profileDir = tempProfileDir;
    process.stderr.write(`Using temporary profile (with cookies) at: ${tempProfileDir}\n`);
  } else if (existsSync(info.profileDir)) {
    args.push(`--user-data-dir=${info.profileDir}`);
    process.stderr.write(`Loading user profile from: ${info.profileDir}\n`);
    if (options.profile) {
      args.push(`--profile-directory=${options.profile}`);
      process.stderr.write(`Using profile: ${options.profile}\n`);
    }
  }

  if (options.headless) {
    args.push("--headless=new");
  }

  process.stderr.write(`Launching ${info.browser} on port ${String(port)}...\n`);

  const child = spawn(info.path, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for CDP endpoint to become available
  const maxWait = 10_000;
  const pollInterval = 500;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    // eslint-disable-next-line no-await-in-loop -- polling must observe each interval before deciding whether to retry
    if (await isPortInUse(port)) {
      // eslint-disable-next-line no-await-in-loop -- version lookup is part of the successful poll iteration
      const version = await getBrowserVersion(port);
      saveConfig({
        port,
        browser: info.browser,
        profileDir,
      });
      return {
        port,
        browser: info.browser,
        profileDir,
        wsUrl: version.webSocketDebuggerUrl ?? `ws://127.0.0.1:${String(port)}`,
      };
    }
    // eslint-disable-next-line no-await-in-loop -- this delay intentionally serializes endpoint polling
    await sleep(pollInterval);
  }

  return null; // Did not start — caller should try next option
}

// ---------------------------------------------------------------------------
// Browser version / connection check
// ---------------------------------------------------------------------------

interface BrowserVersion {
  Browser?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

async function getBrowserVersion(port: number): Promise<BrowserVersion> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
  const value: unknown = await response.json();
  if (!isBrowserVersion(value)) throw new Error("Browser returned an invalid version response");
  return value;
}

function isBrowserVersion(value: unknown): value is BrowserVersion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const browser: unknown = Reflect.get(value, "Browser");
  const webSocketDebuggerUrl: unknown = Reflect.get(value, "webSocketDebuggerUrl");
  return (
    (browser === undefined || typeof browser === "string") &&
    (webSocketDebuggerUrl === undefined || typeof webSocketDebuggerUrl === "string")
  );
}

export async function checkConnection(port: number): Promise<BrowserVersion | null> {
  try {
    return await getBrowserVersion(port);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

export function shutdownBrowser(port: number): void {
  // On Windows, find and kill the chrome process listening on that port
  try {
    if (process.platform === "win32") {
      // Use netstat to find the PID, then taskkill
      const output = execSync(`netstat -ano | findstr :${String(port)} | findstr LISTENING`, {
        encoding: "utf-8",
      });
      const match = output
        .trim()
        .split("\n")[0]
        ?.match(/(\d+)\s*$/);
      if (match?.[1]) {
        execSync(`taskkill /PID ${match[1]} /F`, { stdio: "ignore" });
      }
    } else {
      execSync(`lsof -ti :${String(port)} | xargs kill -9 2>/dev/null || true`, {
        stdio: "ignore",
      });
    }
  } catch {
    // Best-effort shutdown
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
