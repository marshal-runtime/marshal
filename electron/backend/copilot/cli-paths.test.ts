import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  getCopilotCliConfigPath,
  getCopilotCliLogsDir,
  getCopilotCliRoot,
} from "./cli-paths.mjs";

describe("GitHub Copilot CLI paths", () => {
  it("keeps CLI-owned config and logs under the Copilot profile", () => {
    const home = path.join(path.sep, "home", "test");
    const root = path.join(home, ".copilot");

    expect(getCopilotCliRoot(home)).toBe(root);
    expect(getCopilotCliConfigPath(home)).toBe(path.join(root, "config.json"));
    expect(getCopilotCliLogsDir(home)).toBe(path.join(root, "logs"));
  });
});
