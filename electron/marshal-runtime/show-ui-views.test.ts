import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ReactUiCompiler } from "@marshal/agent-runtime-ui";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseViewsArgs,
  planSourceFiles,
  readShowUiRecord,
  renderProps,
  writeShowUiRecord,
} from "./show-ui-views";

const DESKTOP_TSX =
  "export default function Wide() { return <table><tbody><tr><td>wide</td></tr></tbody></table>; }";
const MOBILE_TSX = "export default function Narrow() { return <ul><li>narrow</li></ul>; }";
const entryPathFor = (label: string, source: string) =>
  `.agent/ui/${label}-${source.length.toString(16)}.tsx`;

const workspaces: string[] = [];
afterEach(() => {
  while (workspaces.length) rmSync(workspaces.pop()!, { recursive: true, force: true });
});
function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "show-ui-views-"));
  workspaces.push(dir);
  return dir;
}

describe("parseViewsArgs", () => {
  it("defaults the tsx shorthand to the client the turn came from", () => {
    expect(parseViewsArgs({ tsx: MOBILE_TSX }, "mobile")).toEqual({
      mobile: { kind: "tsx", tsx: MOBILE_TSX },
    });
  });

  it("gives one responsive source to every listed viewport", () => {
    const views = parseViewsArgs(
      { component: "checklist", viewports: ["desktop", "mobile"] },
      "desktop",
    );
    expect(Object.keys(views).sort()).toEqual(["desktop", "mobile"]);
  });

  it("rejects mixing views with the shorthand", () => {
    expect(() => parseViewsArgs({ tsx: MOBILE_TSX, views: {} }, "desktop")).toThrow(/not both/);
  });
});

describe("renderProps", () => {
  it("declares the served viewports and drops caller-supplied reserved keys", () => {
    const props = renderProps(
      { rows: 2, marshalViewports: ["desktop"], marshalViewport: "desktop" },
      { mobile: { kind: "tsx", tsx: MOBILE_TSX } },
    );
    expect(props).toEqual({ rows: 2, marshalViewports: ["mobile"] });
  });
});

describe("show-ui records", () => {
  it("round-trips the views a later refresh merges with", () => {
    const dir = workspace();
    const record = {
      title: "Board",
      props: { a: 1 },
      views: { mobile: { kind: "tsx" as const, tsx: MOBILE_TSX } },
    };
    writeShowUiRecord(dir, "render/1", record);
    expect(readShowUiRecord(dir, "render/1")).toEqual(record);
    expect(readShowUiRecord(dir, "missing")).toBeUndefined();
  });
});

describe("two-view wrapper", () => {
  it("compiles with the real runtime compiler and switches on the client viewport", async () => {
    const dir = workspace();
    const plan = planSourceFiles(
      { desktop: { kind: "tsx", tsx: DESKTOP_TSX }, mobile: { kind: "tsx", tsx: MOBILE_TSX } },
      entryPathFor,
      "board",
    );
    expect(plan.files).toHaveLength(3);
    for (const file of plan.files) {
      const target = path.join(dir, ...file.relativePath.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.source);
    }

    const compiled = await new ReactUiCompiler({ workspacePath: dir }).compileWorkspace(
      { entryPath: plan.entryPath, title: "board" },
      { principal: { id: "test", kind: "agent" }, scope: { sessionId: "s", workspaceId: "w" } },
    );

    expect(compiled.html).toContain("narrow");
    expect(compiled.html).toContain("wide");
    expect(compiled.html).toContain("marshalViewport");
  });

  it("uses a single file when both viewports share a source", () => {
    const shared = { kind: "tsx" as const, tsx: DESKTOP_TSX };
    const plan = planSourceFiles({ desktop: shared, mobile: shared }, entryPathFor, "board");
    expect(plan.files).toHaveLength(1);
  });
});
