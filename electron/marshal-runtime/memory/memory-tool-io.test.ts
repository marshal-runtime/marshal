import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codeLinkHint } from "./memory-tool-io";

describe("codeLinkHint", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "code-link-hint-"));
    mkdirSync(path.join(workspace, "common"));
    mkdirSync(path.join(workspace, "services/agent-gateway"), { recursive: true });
    writeFileSync(path.join(workspace, "common/marshal-logger.ts"), "");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("names the workspace paths a fact mentions", () => {
    const hint = codeLinkHint(
      "Log via common/marshal-logger.ts; `services/agent-gateway` is Noga's; see src/missing.ts.",
      "mem-1",
      workspace,
    );

    expect(hint).toContain("(common/marshal-logger.ts, services/agent-gateway)");
    expect(hint).toContain("forget mem-1");
  });

  it("ignores words with slashes and paths outside the workspace", () => {
    expect(codeLinkHint("Prefer read/write and and/or", "mem-1", workspace)).toBeUndefined();
    expect(
      codeLinkHint(
        "Node is in ~/.local/bin and /Users/omer; docs at https://example.com/common/x; ../common",
        "mem-1",
        workspace,
      ),
    ).toBeUndefined();
  });
});
