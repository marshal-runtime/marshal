import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, "main.ts"), "utf8");

describe("main swarm wiring", () => {
  it("loads the durable agent-message outbox before swarm recovery starts", () => {
    const outboxStart = source.indexOf("await agentMessageOutbox.start({ pauseDispatch: true })");
    const runtimeStart = source.indexOf(
      "if (runtimeDirectoriesReady && !deferRuntimeStart) await startMarshalRuntimeHost()",
    );

    expect(outboxStart).toBeGreaterThan(-1);
    expect(runtimeStart).toBeGreaterThan(outboxStart);
  });
});
