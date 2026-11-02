import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, "main.tsx"), "utf8");

describe("renderer boot cleanup wiring", () => {
  it("disposes query invalidations and the responsiveness probe together on HMR", () => {
    expect(source).toContain(
      "const cleanupQueryInvalidations = wireQueryInvalidations(queryClient);",
    );
    expect(source).toContain("import.meta.hot.dispose(() => {");
    expect(source).toContain("cleanupQueryInvalidations();");
    expect(source).toContain("stopRendererResponsivenessProbe();");
    expect(source).not.toContain(
      "import.meta.hot.dispose(stopRendererResponsivenessProbe)",
    );
  });
});
