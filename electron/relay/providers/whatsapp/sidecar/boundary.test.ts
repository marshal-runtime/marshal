import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sidecarRoot = path.dirname(fileURLToPath(import.meta.url));

describe("WhatsApp sidecar dependency boundary", () => {
  it("keeps Baileys imports and types inside the public-root adapter", () => {
    const imports: Array<{ file: string; specifier: string }> = [];
    for (const filePath of listProductionTypeScriptFiles(sidecarRoot)) {
      const source = readFileSync(filePath, "utf8");
      for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (specifier === "baileys" || specifier.startsWith("baileys/")) {
          imports.push({ file: path.basename(filePath), specifier });
        }
      }
    }

    expect(imports).toEqual([
      { file: "baileys-adapter.ts", specifier: "baileys" },
      { file: "baileys-adapter.ts", specifier: "baileys" },
    ]);
    expect(imports.every(({ specifier }) => specifier === "baileys")).toBe(true);
  });

  it("does not use Baileys' plaintext multi-file auth helper", () => {
    for (const filePath of listProductionTypeScriptFiles(sidecarRoot)) {
      expect(readFileSync(filePath, "utf8")).not.toContain("useMultiFileAuthState");
    }
  });
});

function listProductionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => path.join(directory, entry.name))
    .sort();
}
