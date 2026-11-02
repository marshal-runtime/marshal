import { createInterface } from "node:readline";

import {
  BAILEYS_STAGE0_SCHEMA_VERSION,
  type BaileysStage0ChildFrame,
  parseBaileysStage0ParentFrame,
  serializeBaileysStage0Frame,
} from "../protocol";
import { createBaileysStage0Capabilities } from "./api-fingerprint";

function writeFrame(frame: BaileysStage0ChildFrame): void {
  process.stdout.write(serializeBaileysStage0Frame(frame));
}

async function run(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let state: "awaiting-ping" | "awaiting-shutdown" = "awaiting-ping";

  for await (const line of input) {
    const frame = parseBaileysStage0ParentFrame(line);
    if (state === "awaiting-ping") {
      if (frame.kind !== "ping") {
        throw new Error("Baileys Stage 0 sidecar expected ping as the first frame");
      }
      writeFrame({
        schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
        kind: "capabilities",
        requestId: frame.requestId,
        capabilities: createBaileysStage0Capabilities(),
      });
      state = "awaiting-shutdown";
      continue;
    }

    if (frame.kind !== "shutdown") {
      throw new Error("Baileys Stage 0 sidecar expected shutdown after capabilities");
    }
    writeFrame({
      schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
      kind: "shutdown-ack",
      requestId: frame.requestId,
    });
    input.close();
    return;
  }

  throw new Error("Baileys Stage 0 parent closed stdin before shutdown");
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFrame({
    schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
    kind: "error",
    requestId: "stage0-error",
    code: "PROTOCOL_ERROR",
    message,
  });
  process.exitCode = 1;
}
