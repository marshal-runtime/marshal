import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBaileysStage0Probe, type BaileysStage0LaunchOptions } from "./client";
import { BAILEYS_STAGE0_BUNDLE_NAME } from "./protocol";

function parseArguments(args: string[]): BaileysStage0LaunchOptions {
  if (args.length === 0) {
    return {
      mode: "development",
      sidecarPath: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        BAILEYS_STAGE0_BUNDLE_NAME,
      ),
    };
  }
  if (args.length !== 4 || args[0] !== "--packaged-resources" || args[2] !== "--platform") {
    throw new Error(
      "Usage: baileys-stage0-probe [--packaged-resources <absolute-path> --platform <win32|darwin|linux>]",
    );
  }
  if (args[3] !== "win32" && args[3] !== "darwin" && args[3] !== "linux") {
    throw new Error(`Unsupported packaged platform: ${args[3]}`);
  }
  return {
    mode: "packaged",
    resourcesPath: path.resolve(args[1]),
    platform: args[3],
  };
}

try {
  const result = await runBaileysStage0Probe(parseArguments(process.argv.slice(2)));
  for (const entry of result.transcript) {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Baileys Stage 0 probe failed: ${message}\n`);
  process.exitCode = 1;
}
