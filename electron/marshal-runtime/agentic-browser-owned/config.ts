import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".agentic-browser");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
  port: number;
  host: string;
  browser: "chrome" | "edge";
  currentTargetId?: string;
  profileDir?: string;
}

const DEFAULT_CONFIG: Config = {
  port: 9222,
  host: "127.0.0.1",
  browser: "chrome",
};

export function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, "utf-8");
      // SF-4: config JSON is treated as unknown and merged only when it is a plain object.
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { ...DEFAULT_CONFIG, ...parsed };
      }
    }
  } catch {
    // Ignore parse errors, return defaults
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: Partial<Config>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = loadConfig();
  const merged = { ...existing, ...config };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
