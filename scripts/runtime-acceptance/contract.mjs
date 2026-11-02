import fs from "node:fs";

const STORY_ID = /^MRT-[A-Z]+-\d{3}$/;

export function parseRuntimeAcceptanceContract(contractPath) {
  const rows = [];
  for (const line of fs.readFileSync(contractPath, "utf8").split(/\r?\n/)) {
    if (!line.startsWith("| `MRT-")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/^`|`$/g, ""));
    if (!STORY_ID.test(cells[0] ?? "") || cells.length < 8) continue;
    if (rows.some((row) => row.id === cells[0])) continue;
    rows.push({
      id: cells[0],
      actor: cells[1],
      preconditions: cells[2],
      steps: cells[3],
      expected: cells[4],
      evidenceClass: cells[5],
      evidenceRequired: cells[6],
      severity: cells[7],
    });
  }
  if (rows.length !== 76) {
    throw new Error(`Expected 76 unique Marshal Runtime stories, found ${rows.length}.`);
  }
  return rows;
}

export function buildStoryMap(stories) {
  return stories.map((story) => {
    const family = story.id.split("-")[1];
    const modes = [
      "LIVE-ELECTRON",
      "LIVE-PACKAGED",
      "LIVE-REAL-BACKEND",
      "STATIC",
      "NODE-INTEGRATION",
      "UNIT",
      "PLATFORM-ONLY",
    ].filter((mode) => story.evidenceClass.includes(mode));
    return {
      ...story,
      family,
      modes,
      automatedPaths: automatedPaths(family, modes),
    };
  });
}

function automatedPaths(family, modes) {
  const paths = [];
  if (modes.includes("LIVE-ELECTRON")) {
    paths.push({
      kind: family === "REC" ? "restart-playwright" : "source-playwright",
      entry: "e2e/marshal-runtime-live.test.ts",
      evidence: "stories/<story-id>.json",
    });
  }
  if (modes.includes("STATIC")) {
    paths.push({
      kind: "static-provenance",
      entry: "scripts/runtime-acceptance/static-gates.mjs",
      evidence: "static-gates.json",
    });
  }
  if (modes.includes("NODE-INTEGRATION") || modes.includes("UNIT")) {
    paths.push({
      kind: "targeted-tests",
      entry: "electron/marshal-runtime/**/*.test.ts",
      evidence: "supporting-tests.json",
    });
  }
  if (modes.includes("LIVE-REAL-BACKEND") || modes.includes("LIVE-PACKAGED")) {
    paths.push({
      kind: modes.includes("LIVE-PACKAGED") ? "packaged-real-suite" : "real-backend-suite",
      entry: "e2e-real/test-suites/99-marshal-runtime.mjs",
      evidence: "real-backend/runtime-story-results.json",
    });
  }
  if (modes.includes("PLATFORM-ONLY")) {
    paths.push({
      kind: "platform-contract",
      entry: "runtime-platform acceptance suite",
      evidence: "platform-evidence.json",
    });
  }
  return paths;
}
