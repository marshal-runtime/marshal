/**
 * Cross-platform Chromium browser detection.
 *
 * Probes well-known installation paths for Edge (Stable → Beta → Dev)
 * and Chrome, returning both the executable path and the Playwright
 * channel name so callers can use it for CDP launches or Playwright MCP.
 */

import { execSync } from "child_process";
import { lstatSync } from "fs";
import { platform } from "os";

export interface BrowserInfo {
  /** Absolute path to the browser executable */
  path: string;
  /** Playwright channel name (msedge, msedge-beta, msedge-dev, chrome) */
  channel: string;
}

interface Candidate {
  path: string;
  channel: string;
}

function listCandidates(): Candidate[] {
  const operatingSystem = platform();
  switch (operatingSystem) {
    case "darwin":
      return [
        {
          path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          channel: "msedge",
        },
        {
          path: "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
          channel: "msedge-beta",
        },
        {
          path: "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
          channel: "msedge-dev",
        },
        { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", channel: "chrome" },
      ];
    case "win32":
      return [
        {
          path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          channel: "msedge",
        },
        { path: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", channel: "msedge" },
        {
          path: "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe",
          channel: "msedge-beta",
        },
        {
          path: "C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe",
          channel: "msedge-beta",
        },
        {
          path: "C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe",
          channel: "msedge-dev",
        },
        {
          path: "C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe",
          channel: "msedge-dev",
        },
        { path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", channel: "chrome" },
        {
          path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          channel: "chrome",
        },
      ];
    default:
      return [
        { path: "/usr/bin/microsoft-edge", channel: "msedge" },
        { path: "/usr/bin/microsoft-edge-stable", channel: "msedge" },
        { path: "/usr/bin/microsoft-edge-beta", channel: "msedge-beta" },
        { path: "/usr/bin/microsoft-edge-dev", channel: "msedge-dev" },
        { path: "/usr/bin/google-chrome", channel: "chrome" },
        { path: "/usr/bin/chromium-browser", channel: "chrome" },
        { path: "/usr/bin/chromium", channel: "chrome" },
      ];
  }
}

const PROGID_TO_CHANNEL: Record<string, string> = {
  MSEdgeHTM: "msedge",
  MSEdgeBHTML: "msedge-beta",
  MSEdgeDHTML: "msedge-dev",
};

/**
 * Query the OS for the default browser. Returns an Edge channel string
 * if the default is an Edge variant, or `null` otherwise.
 */
export function getDefaultEdgeChannel(): string | null {
  try {
    switch (platform()) {
      case "win32": {
        const out = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" /v ProgId',
          { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "ignore"] },
        );
        const match = out.match(/ProgId\s+REG_SZ\s+(\S+)/);
        return match ? (PROGID_TO_CHANNEL[match[1]] ?? null) : null;
      }
      case "darwin": {
        const out = execSync(
          `osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com")).path.js'`,
          { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "ignore"] },
        );
        const appPath = out.trim();
        if (appPath.includes("Microsoft Edge Beta")) return "msedge-beta";
        if (appPath.includes("Microsoft Edge Dev")) return "msedge-dev";
        if (appPath.includes("Microsoft Edge")) return "msedge";
        return null;
      }
      default: {
        const out = execSync("xdg-settings get default-web-browser", {
          encoding: "utf-8",
          timeout: 3000,
          stdio: ["pipe", "pipe", "ignore"],
        });
        const desktop = out.trim();
        if (desktop.includes("microsoft-edge-beta")) return "msedge-beta";
        if (desktop.includes("microsoft-edge-dev")) return "msedge-dev";
        if (desktop.includes("microsoft-edge")) return "msedge";
        return null;
      }
    }
  } catch {
    return null;
  }
}

/**
 * Detect the best available Chromium-based browser.
 *
 * If the system default browser is an Edge variant, prefer it.
 * Otherwise fall back to: Edge Stable → Edge Beta → Edge Dev → Chrome.
 * Honors the `MARSHAL_BROWSER_PATH` / `MARSHAL_BROWSER_CHANNEL` environment overrides.
 */
export function detectBrowser(): BrowserInfo {
  if (process.env.MARSHAL_BROWSER_PATH) {
    const channel = process.env.MARSHAL_BROWSER_CHANNEL ?? "msedge";
    return { path: process.env.MARSHAL_BROWSER_PATH, channel };
  }

  const candidates = listCandidates();

  // If the system default browser is an Edge variant, try all matching paths first
  const preferredChannel = getDefaultEdgeChannel();
  if (preferredChannel) {
    for (const preferred of candidates.filter((c) => c.channel === preferredChannel)) {
      try {
        lstatSync(preferred.path);
        return preferred;
      } catch {
        // not found at this path, try next
      }
    }
  }

  // Fall back to candidate-list order
  for (const candidate of candidates) {
    try {
      lstatSync(candidate.path);
      return candidate;
    } catch {
      // not found, try next
    }
  }

  // Return first candidate so the caller's lstatSync check produces a clear error
  return candidates[0];
}
