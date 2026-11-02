import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_TS = path.join(__dirname, "main.ts");

describe("main.ts workflow recovery startup order", () => {
  const source = readFileSync(MAIN_TS, "utf8");

  it("boots encrypted workflow state only inside app.whenReady", () => {
    const whenReady = source.indexOf("void app.whenReady().then(async () => {");
    const workflowBoots = [
      ...source.matchAll(/workflowManager\s*\.bootAndReattachInflight\s*\(\s*\)/g),
    ];

    expect(whenReady).toBeGreaterThan(-1);
    expect(workflowBoots).toHaveLength(1);
    expect(workflowBoots[0].index).toBeGreaterThan(whenReady);
  });
});