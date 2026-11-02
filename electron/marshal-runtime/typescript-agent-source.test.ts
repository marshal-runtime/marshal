import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTypeScriptExecutor } from "@marshal/agent-runtime-typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TRUSTED_TYPESCRIPT_IMPORT_POLICY } from "./trusted-typescript";
import { prepareAgentTypeScriptSource } from "./typescript-agent-source";

describe("prepareAgentTypeScriptSource", () => {
  const executor = createTypeScriptExecutor({
    mode: "trusted",
    allowedBuiltins: TRUSTED_TYPESCRIPT_IMPORT_POLICY.allowedBuiltins,
    allowedPackages: TRUSTED_TYPESCRIPT_IMPORT_POLICY.allowedPackages,
  });
  let runtimeRoot: string;
  let workspace: string;

  beforeAll(async () => {
    runtimeRoot = await realpath(await mkdtemp(path.join(tmpdir(), "ts-agent-runtime-")));
    workspace = await realpath(await mkdtemp(path.join(tmpdir(), "ts-agent-workspace-")));
    await writeFile(path.join(workspace, "data.json"), JSON.stringify({ items: [1, 2, 3] }));
  });

  afterAll(async () => {
    await executor.dispose();
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  const run = (source: string, input: Record<string, string> = {}) =>
    executor.execute({
      source: prepareAgentTypeScriptSource(source, { trusted: true, workspacePath: workspace }),
      input,
      workingDirectory: runtimeRoot,
    });

  it("runs a body-only snippet with hoisted imports, auto process, and the workspace cwd", async () => {
    const result = await run(
      [
        'import { readFile } from "node:fs/promises";',
        'const data = JSON.parse(await readFile("data.json", "utf8"));',
        "return { sum: data.items.reduce((a: number, b: number) => a + b, 0), cwd: process.cwd(), tag: input.tag };",
      ].join("\n"),
      { tag: "x" },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      value: { sum: 6, cwd: workspace, tag: "x" },
    });
  });

  it("keeps full modules working and adds Buffer without an explicit import", async () => {
    const result = await run(
      'export default async () => Buffer.from("hi").toString("base64") + ":" + process.cwd();',
    );
    expect(result).toMatchObject({ status: "succeeded", value: `aGk=:${workspace}` });
  });

  it("preserves the agent's line numbers in compile diagnostics", async () => {
    const result = await run(
      ['import path from "node:path";', "", 'const n: number = "x";'].join("\n"),
    );
    expect(result.status).toBe("compile_failed");
    expect(result.diagnostics[0]?.location?.line).toBe(3);
  });

  it("does not duplicate an existing process import", () => {
    const source = 'import process from "node:process";\nexport default () => process.pid;';
    const prepared = prepareAgentTypeScriptSource(source, { trusted: true });
    expect(prepared).toBe(source);
  });

  it("leaves multi-line imports and brokered module sources untouched", () => {
    const multiLine = 'import {\n  readFile,\n} from "node:fs/promises";\nreturn 1;';
    expect(prepareAgentTypeScriptSource(multiLine, { trusted: false })).toBe(multiLine);
    const module = "export default async () => 1;";
    expect(prepareAgentTypeScriptSource(module, { trusted: false, workspacePath: "/w" })).toBe(
      module,
    );
  });

  it("wraps a brokered body-only snippet without Node preludes", () => {
    const prepared = prepareAgentTypeScriptSource("return context.runtime.search(input.q);", {
      trusted: false,
      workspacePath: "/w",
    });
    expect(prepared).toBe(
      "export default async (input, context) => { return context.runtime.search(input.q);\n};",
    );
  });
});
