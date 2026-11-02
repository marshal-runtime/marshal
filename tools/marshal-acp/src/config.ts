import fs from "node:fs/promises";

import { configPath, resolveBase, sessionsDir } from "./paths.ts";
import { MarshalAcpConfigSchema, type MarshalAcpConfig } from "./types.ts";

export async function loadConfig(): Promise<MarshalAcpConfig> {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    return MarshalAcpConfigSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return MarshalAcpConfigSchema.parse({});
    }
    throw err;
  }
}

export async function ensureBase(): Promise<void> {
  await fs.mkdir(resolveBase(), { recursive: true });
  await fs.mkdir(sessionsDir(), { recursive: true });
}

/** Returns true when a new config was written; false when one already existed. */
export async function writeDefaultConfigIfMissing(): Promise<boolean> {
  try {
    await fs.access(configPath());
    return false;
  } catch {
    const cfg = MarshalAcpConfigSchema.parse({});
    await fs.writeFile(configPath(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    return true;
  }
}
