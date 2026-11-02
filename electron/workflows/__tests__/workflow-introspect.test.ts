import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearWorkflowIntrospectionCacheForTests,
  loadDefinitionFromCompiled,
} from "../workflow-introspect";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-introspect-test-"));
  clearWorkflowIntrospectionCacheForTests();
  Reflect.deleteProperty(globalThis, "__workflowIntrospectTestLoads");
});

afterEach(() => {
  clearWorkflowIntrospectionCacheForTests();
  Reflect.deleteProperty(globalThis, "__workflowIntrospectTestLoads");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function compiledWorkflow(label: string): string {
  return `
globalThis.__workflowIntrospectTestLoads = (globalThis.__workflowIntrospectTestLoads || 0) + 1;
module.exports = { default: {
  id: "cache-demo",
  displayName: "Cache Demo",
  schemaVersion: 1,
  agentRequirements: [{ slot: ${JSON.stringify(label)}, role: "Test role" }],
  run: async () => ({ ok: true }),
}};
`;
}

function loadCount(): number {
  const value: unknown = Reflect.get(globalThis, "__workflowIntrospectTestLoads");
  return typeof value === "number" ? value : 0;
}

describe("workflow introspection cache", () => {
  it("reuses definitions for identical compiled bytes", async () => {
    const compiled = compiledWorkflow("first");

    const first = await loadDefinitionFromCompiled(compiled, "cache-demo", tmpRoot);
    const second = await loadDefinitionFromCompiled(compiled, "cache-demo", tmpRoot);

    expect(loadCount()).toBe(1);
    expect(second).toBe(first);
    expect(second.agentRequirements?.[0]?.slot).toBe("first");
  });

  it("reloads when compiled bytes change", async () => {
    await loadDefinitionFromCompiled(compiledWorkflow("first"), "cache-demo", tmpRoot);
    const second = await loadDefinitionFromCompiled(
      compiledWorkflow("second"),
      "cache-demo",
      tmpRoot,
    );

    expect(loadCount()).toBe(2);
    expect(second.agentRequirements?.[0]?.slot).toBe("second");
  });
});
