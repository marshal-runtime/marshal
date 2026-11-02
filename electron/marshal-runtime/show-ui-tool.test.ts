import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ReactUiCompiler } from "@marshal/agent-runtime-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MarshalRuntimeApi,
  MarshalRuntimeApiResult,
  MarshalRuntimeInvocationValue,
  MarshalRuntimeInvokeRequest,
} from "./contracts";
import { createShowUiTool } from "./show-ui-tool";
import { writeShowUiRecord } from "./show-ui-views";

const scope = { sessionId: "session-1", workspaceName: "marshal" };
type InvokeResult = MarshalRuntimeApiResult<MarshalRuntimeInvocationValue>;

function success(output: unknown): InvokeResult {
  return { ok: true, value: { output, result: { output } }, receipts: [] };
}

function uiEnvelope(value: unknown): InvokeResult {
  return success({ ok: true, value });
}

function instance(instanceId: string, applicationId: string, surface = "inline-card") {
  return { instanceId, surface, owner: { extensionId: "marshal.react-ui", applicationId } };
}

function fakeApi(
  handlers: Record<
    string,
    (request: MarshalRuntimeInvokeRequest) => InvokeResult | Promise<InvokeResult>
  >,
) {
  const invoke = vi.fn<MarshalRuntimeApi["invoke"]>(async (request) => {
    const handler = handlers[request.capability];
    if (!handler) throw new Error(`unexpected capability ${request.capability}`);
    return handler(request);
  });
  const api: MarshalRuntimeApi = {
    search: vi.fn<MarshalRuntimeApi["search"]>(),
    invoke,
    executeTypeScript: vi.fn<MarshalRuntimeApi["executeTypeScript"]>(),
    executeModule: vi.fn<MarshalRuntimeApi["executeModule"]>(),
    listRenderTools: vi.fn<MarshalRuntimeApi["listRenderTools"]>(),
    invokeRenderTool: vi.fn<MarshalRuntimeApi["invokeRenderTool"]>(),
    listExtensions: vi.fn<MarshalRuntimeApi["listExtensions"]>(),
    installExtension: vi.fn<MarshalRuntimeApi["installExtension"]>(),
    installLocalExtension: vi.fn<MarshalRuntimeApi["installLocalExtension"]>(),
    configureExtension: vi.fn<MarshalRuntimeApi["configureExtension"]>(),
    setProvider: vi.fn<MarshalRuntimeApi["setProvider"]>(),
    clearProvider: vi.fn<MarshalRuntimeApi["clearProvider"]>(),
    repairContractConflict: vi.fn<MarshalRuntimeApi["repairContractConflict"]>(),
    readResource: vi.fn<MarshalRuntimeApi["readResource"]>(),
    updateExtension: vi.fn<MarshalRuntimeApi["updateExtension"]>(),
    enableExtension: vi.fn<MarshalRuntimeApi["enableExtension"]>(),
    disableExtension: vi.fn<MarshalRuntimeApi["disableExtension"]>(),
    removeExtension: vi.fn<MarshalRuntimeApi["removeExtension"]>(),
    getStatus: vi.fn<MarshalRuntimeApi["getStatus"]>(),
  };
  return { api, invoke };
}

const workspaces: string[] = [];
afterEach(() => {
  while (workspaces.length) rmSync(workspaces.pop()!, { recursive: true, force: true });
});

async function run(
  api: MarshalRuntimeApi,
  args: Record<string, unknown>,
  existingWorkspace?: string,
) {
  const workspace = existingWorkspace ?? mkdtempSync(path.join(tmpdir(), "show-ui-"));
  if (!existingWorkspace) workspaces.push(workspace);
  const tool = createShowUiTool({
    api,
    resolveScope: async () => scope,
    resolveWorkspacePath: async () => workspace,
  });
  const raw = await tool.handler(args, {
    sessionId: scope.sessionId,
    toolCallId: "call-1",
    toolName: tool.name,
    arguments: args,
  });
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("expected a JSON object");
  return { workspace, result: Object.fromEntries(Object.entries(parsed)) };
}

const TSX = "export default function Hello() { return <p>hi</p>; }";

function sourcesOf(result: Record<string, unknown>): Record<string, string> {
  const value = result.sources;
  if (typeof value !== "object" || value === null) throw new Error("expected sources");
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

describe("runtimeShowUi", () => {
  it("writes the source, then compiles, renders, and opens it under the authored owner", async () => {
    const { api, invoke } = fakeApi({
      "ui.compile": () => success({ component: { id: "component-1" } }),
      "ui.render": () => success({ render: { id: "render-1" } }),
      "ui.application.open": () =>
        uiEnvelope({ instance: instance("instance-1", "render-1", "panel") }),
    });

    const { workspace, result } = await run(api, { title: "Hello", tsx: TSX, surface: "panel" });

    expect(result).toMatchObject({
      ok: true,
      instanceId: "instance-1",
      renderId: "render-1",
      surface: "panel",
    });
    const sources = sourcesOf(result);
    expect(Object.keys(sources)).toEqual(["desktop"]);
    expect(path.isAbsolute(sources.desktop)).toBe(true);
    expect(sources.desktop.startsWith(workspace)).toBe(true);
    expect(readFileSync(sources.desktop, "utf8")).toBe(TSX);
    expect(result.replaced).toBeUndefined();
    expect(invoke.mock.calls.map(([request]) => request.capability)).toEqual([
      "ui.compile",
      "ui.render",
      "ui.application.open",
    ]);
    expect(invoke.mock.calls[2]?.[0].input).toMatchObject({
      extensionId: "marshal.react-ui",
      applicationId: "render-1",
      surface: "panel",
    });
  });

  it("refreshes an open instance in place: same id and surface, no close", async () => {
    const { api, invoke } = fakeApi({
      "ui.application.list": () =>
        uiEnvelope({ instances: [instance("instance-old", "render-old", "tab")] }),
      "ui.compile": () => success({ component: { id: "component-2" } }),
      "ui.render": () => success({ render: { id: "render-new" } }),
      "ui.application.open": () =>
        uiEnvelope({ instance: instance("instance-old", "render-new", "tab") }),
    });

    const { result } = await run(api, {
      title: "Board",
      component: "checklist",
      props: { items: [{ id: "a", label: "Step", status: "done" }] },
      instanceId: "instance-old",
    });

    expect(result).toMatchObject({
      ok: true,
      instanceId: "instance-old",
      surface: "tab",
      replaced: "instance-old",
    });
    const byCapability = new Map(
      invoke.mock.calls.map(([request]) => [request.capability, request.input]),
    );
    expect(byCapability.get("ui.application.open")).toMatchObject({
      applicationId: "render-new",
      surface: "tab",
      replaceInstanceId: "instance-old",
    });
    expect(byCapability.has("ui.application.close")).toBe(false);
  });

  it("reports not-found for an instanceId that is not an open authored instance", async () => {
    const { api } = fakeApi({
      "ui.application.list": () => uiEnvelope({ instances: [] }),
      "ui.compile": () => success({ component: { id: "component-3" } }),
      "ui.render": () => success({ render: { id: "render-3" } }),
    });

    const { result } = await run(api, { title: "X", tsx: TSX, instanceId: "missing" });

    expect(result).toMatchObject({ ok: false, stage: "update", error: { code: "not-found" } });
  });

  it("rejects invalid built-in props before touching the runtime", async () => {
    const { api, invoke } = fakeApi({});

    const { result } = await run(api, {
      title: "T",
      component: "data-table",
      props: { columns: [] },
    });

    expect(result).toMatchObject({ ok: false, stage: "props" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns line and column diagnostics when compilation fails", async () => {
    const { api } = fakeApi({
      "ui.compile": () => ({
        ok: false,
        error: {
          code: "operation-failed",
          message: '.agent/ui/x.tsx:3:14: ERROR: Expected ">" but found "}"',
        },
        receipts: [],
      }),
    });

    const { result } = await run(api, { title: "X", tsx: TSX });

    expect(result).toEqual({
      ok: false,
      stage: "compile",
      diagnostics: [{ message: 'Expected ">" but found "}"', line: 3, column: 14 }],
    });
  });

  it("surfaces a nested ui.application.open failure instead of reporting success", async () => {
    const { api } = fakeApi({
      "ui.compile": () => success({ component: { id: "component-4" } }),
      "ui.render": () => success({ render: { id: "render-4" } }),
      "ui.application.open": () =>
        success({ ok: false, error: { code: "permission-denied", message: "denied" } }),
    });

    const { result } = await run(api, { title: "X", tsx: TSX });

    expect(result).toMatchObject({
      ok: false,
      stage: "open",
      error: { code: "permission-denied" },
    });
  });
  it("adds a desktop view to a phone-only instance and keeps the phone view", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "show-ui-"));
    workspaces.push(workspace);
    writeShowUiRecord(workspace, "render-phone", {
      title: "Orders",
      props: { count: 2 },
      views: { mobile: { kind: "tsx", tsx: TSX } },
    });
    const { api, invoke } = fakeApi({
      "ui.application.list": () =>
        uiEnvelope({ instances: [instance("instance-phone", "render-phone", "panel")] }),
      "ui.compile": () => success({ component: { id: "component-both" } }),
      "ui.render": () => success({ render: { id: "render-both" } }),
      "ui.application.open": () =>
        uiEnvelope({ instance: instance("instance-both", "render-both", "panel") }),
      "ui.application.close": () => uiEnvelope({}),
    });

    const desktopTsx = "export default function Wide() { return <table />; }";
    const { result } = await run(
      api,
      { instanceId: "instance-phone", views: { desktop: { tsx: desktopTsx } } },
      workspace,
    );

    expect(result).toMatchObject({ ok: true, viewports: ["desktop", "mobile"] });
    const render = invoke.mock.calls.find(([request]) => request.capability === "ui.render");
    expect(render?.[0].input).toMatchObject({
      props: { count: 2, marshalViewports: ["desktop", "mobile"] },
    });
    const compile = invoke.mock.calls.find(([request]) => request.capability === "ui.compile");
    expect(compile?.[0].input).toMatchObject({ title: "Orders" });
  });

  it("keeps an in-place edit of a view's live source file when another view is replaced", async () => {
    const { api } = fakeApi({
      "ui.compile": () => success({ component: { id: "component-1" } }),
      "ui.render": () => success({ render: { id: "render-1" } }),
      "ui.application.open": () =>
        uiEnvelope({ instance: instance("instance-1", "render-1", "panel") }),
    });
    const first = await run(api, { title: "Board", tsx: TSX, viewports: ["desktop"] });
    const desktopSource = sourcesOf(first.result).desktop;
    const editedTsx = "export default function Hello() { return <p>edited</p>; }";
    writeFileSync(desktopSource, editedTsx);

    const { api: refreshApi } = fakeApi({
      "ui.application.list": () =>
        uiEnvelope({ instances: [instance("instance-1", "render-1", "panel")] }),
      "ui.compile": () => success({ component: { id: "component-2" } }),
      "ui.render": () => success({ render: { id: "render-2" } }),
      "ui.application.open": () =>
        uiEnvelope({ instance: instance("instance-2", "render-2", "panel") }),
      "ui.application.close": () => uiEnvelope({}),
    });
    const phoneTsx = "export default function Narrow() { return <ul />; }";
    const { result } = await run(
      refreshApi,
      { instanceId: "instance-1", views: { mobile: { tsx: phoneTsx } } },
      first.workspace,
    );

    expect(result).toMatchObject({
      ok: true,
      replaced: "instance-1",
      viewports: ["desktop", "mobile"],
    });
    const sources = sourcesOf(result);
    expect(readFileSync(sources.desktop, "utf8")).toBe(editedTsx);
    expect(readFileSync(sources.mobile, "utf8")).toBe(phoneTsx);
  });
});

function directory(): string {
  const created = realpathSync(mkdtempSync(path.join(tmpdir(), "show-ui-file-")));
  workspaces.push(created);
  return created;
}

function write(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function setup(
  compile: (compileRoot: string, entryPath: string) => Promise<void> = async () => undefined,
) {
  const compileRoot = directory();
  const workspaceDir = directory();
  const compiled: string[] = [];
  let renders = 0;
  const handle = async (request: MarshalRuntimeInvokeRequest): Promise<InvokeResult> => {
    if (request.capability === "ui.application.list") {
      return success({
        ok: true,
        value: {
          instances: [
            {
              instanceId: "instance-1",
              surface: "tab",
              owner: { extensionId: "marshal.react-ui", applicationId: "render-1" },
            },
          ],
        },
      });
    }
    if (request.capability === "ui.compile") {
      const entryPath = String(Reflect.get(Object(request.input), "entryPath"));
      compiled.push(entryPath);
      await compile(compileRoot, entryPath);
      return success({ component: { id: "component-1" } });
    }
    if (request.capability === "ui.render") {
      renders += 1;
      return success({ render: { id: `render-${renders}` } });
    }
    if (request.capability === "ui.application.open") {
      return success({
        ok: true,
        value: {
          instance: {
            instanceId: "instance-1",
            surface: "tab",
            owner: { extensionId: "marshal.react-ui", applicationId: `render-${renders}` },
          },
        },
      });
    }
    throw new Error(`unexpected capability ${request.capability}`);
  };
  const { api } = fakeApi({
    "ui.application.list": handle,
    "ui.compile": handle,
    "ui.render": handle,
    "ui.application.open": handle,
  });
  const tool = createShowUiTool({
    api,
    resolveScope: async () => scope,
    resolveWorkspacePath: async () => compileRoot,
    resolveFileAccess: () => ({
      workspaceDir,
      readGrants: [],
      writeGrants: [],
      allowedSensitivePaths: [],
    }),
  });
  const show = async (args: Record<string, unknown>) => {
    const raw = await tool.handler(args, {
      sessionId: scope.sessionId,
      toolCallId: "call-1",
      toolName: tool.name,
      arguments: args,
    });
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("expected a JSON object");
    return Object.fromEntries(Object.entries(parsed));
  };
  return { compileRoot, workspaceDir, compiled, show };
}

const ENTRY = `import { Row } from "./parts/row";
import { total } from "../lib/total.js";
import "./view.css";
export { helper } from "./parts/helper";
export default function View() { return <Row value={total} />; }
`;

describe("runtimeShowUi file source", () => {
  it("compiles an entry file with the files it imports, keeping their layout", async () => {
    const { compileRoot, workspaceDir, compiled, show } = setup();
    write(workspaceDir, "ui/view.tsx", ENTRY);
    write(workspaceDir, "ui/view.css", "p { color: red; }");
    write(
      workspaceDir,
      "ui/parts/row.tsx",
      `export const Row = (p: { value: number }) => <p>{p.value}</p>;`,
    );
    write(workspaceDir, "ui/parts/helper/index.ts", "export const helper = 1;");
    write(workspaceDir, "lib/total.ts", "export const total = 3;");
    write(workspaceDir, "ui/unrelated.tsx", "export default 1;");

    const result = await show({ title: "View", file: path.join(workspaceDir, "ui/view.tsx") });

    expect(result).toMatchObject({ ok: true });
    const entry = compiled[0];
    expect(entry).toMatch(/^\.agent\/ui\/files\/[a-f0-9]{16}\/ui\/view\.tsx$/);
    expect(sourcesOf(result).desktop).toBe(path.join(compileRoot, entry));
    const copied = path.dirname(path.dirname(path.join(compileRoot, entry)));
    expect(readFileSync(path.join(copied, "ui/view.tsx"), "utf8")).toBe(ENTRY);
    expect(existsSync(path.join(copied, "ui/view.css"))).toBe(true);
    expect(existsSync(path.join(copied, "ui/parts/row.tsx"))).toBe(true);
    expect(existsSync(path.join(copied, "ui/parts/helper/index.ts"))).toBe(true);
    expect(existsSync(path.join(copied, "lib/total.ts"))).toBe(true);
    expect(existsSync(path.join(copied, "ui/unrelated.tsx"))).toBe(false);
  });

  it("gives the real compiler everything a multi-file view imports", async () => {
    let html = "";
    const { workspaceDir, show } = setup(async (compileRoot, entryPath) => {
      const compiler = new ReactUiCompiler({ workspacePath: compileRoot });
      const context = { principal: { id: "test", kind: "agent" } };
      html = (await compiler.compileWorkspace({ entryPath, title: "View" }, context)).html;
    });
    write(workspaceDir, "ui/view.tsx", ENTRY);
    write(workspaceDir, "ui/view.css", ".from-css { color: rebeccapurple; }");
    write(
      workspaceDir,
      "ui/parts/row.tsx",
      `export const Row = (props: { value: string }) => <p>{"marker-row"}{props.value}</p>;`,
    );
    write(workspaceDir, "ui/parts/helper/index.ts", `export const helper = "marker-helper";`);
    write(workspaceDir, "lib/total.ts", `export const total = "marker-total";`);

    const result = await show({ title: "View", file: path.join(workspaceDir, "ui/view.tsx") });

    expect(result).toMatchObject({ ok: true });
    expect(html).toContain("marker-row");
    expect(html).toContain("marker-total");
    expect(html).toContain("from-css");
  });

  it("resolves a relative path against the session workspace", async () => {
    const { workspaceDir, compiled, show } = setup();
    write(workspaceDir, "view.tsx", "export default () => <p>hi</p>;");
    expect(await show({ title: "View", file: "view.tsx" })).toMatchObject({ ok: true });
    expect(compiled[0]).toMatch(/\/view\.tsx$/);
  });

  it("picks up an edited original when called again with the same file", async () => {
    const { workspaceDir, compiled, show } = setup();
    const file = write(workspaceDir, "view.tsx", "export default () => <p>one</p>;");
    await show({ title: "View", file });
    write(workspaceDir, "view.tsx", "export default () => <p>two</p>;");
    await show({ title: "View", file });
    expect(compiled[1]).not.toBe(compiled[0]);
  });

  it("wraps different desktop and mobile files, and mixes a file with inline tsx", async () => {
    const { compileRoot, workspaceDir, compiled, show } = setup();
    const desktop = write(workspaceDir, "desktop.tsx", "export default () => <p>wide</p>;");
    const result = await show({
      title: "Two",
      views: { desktop: { file: desktop }, mobile: { tsx: "export default () => <p>narrow</p>;" } },
    });
    expect(result).toMatchObject({ ok: true });
    const wrapper = readFileSync(path.join(compileRoot, compiled[0]), "utf8");
    expect(wrapper).toMatch(/import DesktopView from "\.\/files\/[a-f0-9]{16}\/desktop";/);
    expect(wrapper).toMatch(/import MobileView from "\.\/two-mobile-[a-f0-9]{12}";/);
    expect(sourcesOf(result).desktop).toContain("/files/");
  });

  it("uses one compiled source when one file serves both viewports", async () => {
    const { compiled, workspaceDir, show } = setup();
    const file = write(workspaceDir, "view.tsx", "export default () => <p>any</p>;");
    await show({ title: "Both", file, viewports: ["desktop", "mobile"] });
    expect(compiled[0]).toMatch(/\/view\.tsx$/);
  });

  it("refuses an entry outside the workspace without copying it", async () => {
    const { compileRoot, compiled, show } = setup();
    const outside = write(directory(), "secret.tsx", "export default 1;");
    const result = await show({ title: "View", file: outside });
    expect(result).toMatchObject({
      ok: false,
      stage: "source",
      error: { code: "permission-denied" },
    });
    expect(compiled).toEqual([]);
    expect(existsSync(path.join(compileRoot, ".agent/ui/files"))).toBe(false);
  });

  it("refuses an import that leaves the workspace, directly or through a symlink", async () => {
    const { compileRoot, workspaceDir, show } = setup();
    const outside = write(directory(), "secret.ts", "export const secret = 1;");
    const relative = path.relative(workspaceDir, outside);
    const entry = write(
      workspaceDir,
      "view.tsx",
      `import { secret } from "./${relative}";\nexport default () => secret;`,
    );
    expect(await show({ title: "View", file: entry })).toMatchObject({
      ok: false,
      stage: "source",
      error: { code: "permission-denied" },
    });
    symlinkSync(outside, path.join(workspaceDir, "linked.ts"));
    const linked = write(
      workspaceDir,
      "linked-view.tsx",
      `import { secret } from "./linked";\nexport default () => secret;`,
    );
    expect(await show({ title: "View", file: linked })).toMatchObject({
      ok: false,
      stage: "source",
      error: { code: "permission-denied" },
    });
    expect(existsSync(path.join(compileRoot, ".agent/ui/files"))).toBe(false);
  });

  it("reports a missing file or an unsupported extension as a source error", async () => {
    const { workspaceDir, show } = setup();
    expect(await show({ title: "View", file: "nope.tsx" })).toMatchObject({
      ok: false,
      stage: "source",
      error: { code: "not-found" },
    });
    write(workspaceDir, ".env", "TOKEN=x");
    expect(await show({ title: "View", file: ".env" })).toMatchObject({
      ok: false,
      stage: "source",
      error: { code: "invalid-request" },
    });
  });

  it("leaves an import it cannot resolve for the compiler to report", async () => {
    const { compiled, workspaceDir, show } = setup();
    const entry = write(
      workspaceDir,
      "view.tsx",
      `import "./missing";\nexport default () => null;`,
    );
    expect(await show({ title: "View", file: entry })).toMatchObject({ ok: true });
    expect(compiled).toHaveLength(1);
  });

  it("keeps a file view when a refresh only changes another viewport", async () => {
    const { compileRoot, workspaceDir, compiled, show } = setup();
    const file = write(workspaceDir, "view.tsx", "export default () => <p>wide</p>;");
    const first = await show({ title: "View", file, viewports: ["desktop"] });
    const prior = JSON.stringify({
      title: "View",
      props: {},
      views: { desktop: { kind: "file", path: compiled[0] } },
      viewPaths: { desktop: compiled[0] },
    });
    write(compileRoot, ".agent/ui/renders/render-1.json", prior);
    const refreshed = await show({
      instanceId: "instance-1",
      views: { mobile: { tsx: "export default () => <p>narrow</p>;" } },
    });
    expect(refreshed).toMatchObject({ ok: true });
    expect(sourcesOf(refreshed).desktop).toBe(sourcesOf(first).desktop);
    expect(readFileSync(path.join(compileRoot, compiled[1]), "utf8")).toContain("/files/");
  });

  it("rejects a call naming more than one source", async () => {
    const { workspaceDir, show } = setup();
    const file = write(workspaceDir, "view.tsx", "export default () => null;");
    await expect(show({ title: "View", file, tsx: "export default () => null;" })).rejects.toThrow(
      "exactly one of tsx, file, or component",
    );
  });
});
