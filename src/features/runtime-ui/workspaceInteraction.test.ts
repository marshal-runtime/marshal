import type { editor, IRange } from "monaco-editor";
import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../../electron/testing/harness";
import { WorkspaceInteraction } from "./workspaceInteraction";

function fixture() {
  const listeners = new Map<string, () => void>();
  const event = (name: string) => (handler: () => void) => {
    listeners.set(name, handler);
    return { dispose: vi.fn<() => void>() };
  };
  const layers: Array<{ set: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }> = [];
  const model = {
    getVersionId: () => 1,
    getLanguageId: () => "typescript",
    getValue: () => "const a = 1;",
    getValueLength: () => 12,
    validateRange: (range: IRange) => ({
      ...range,
      endLineNumber: Math.min(10, range.endLineNumber),
    }),
  };
  const view = {
    getModel: () => model,
    getSelection: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 }),
    getVisibleRanges: () => [],
    hasTextFocus: () => true,
    getDomNode: () => ({ getClientRects: () => [1] }),
    onDidChangeCursorSelection: event("selection"),
    onDidScrollChange: event("scroll"),
    onDidFocusEditorText: event("focus"),
    onDidBlurEditorText: event("blur"),
    onDidChangeModel: event("model"),
    onDidChangeModelContent: event("edit"),
    createDecorationsCollection: () => {
      const layer = {
        set: vi.fn<(decorations: editor.IModelDeltaDecoration[]) => void>(),
        clear: vi.fn<() => void>(),
      };
      layers.push(layer);
      return layer;
    },
    revealRangeInCenter: vi.fn<() => void>(),
    setSelection: vi.fn<() => void>(),
    focus: vi.fn<() => void>(),
  };
  const workspace = new WorkspaceInteraction();
  const scope = { workspaceName: "a", sessionId: "one" };
  const unregister = workspace.register(
    scope,
    "/work/a.ts",
    testDouble<editor.IStandaloneCodeEditor>(view),
  );
  const document = workspace.snapshot(scope).documents[0];
  return { workspace, scope, document, unregister, view, listeners, layers };
}
const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 };
const notes = [{ id: "a", range, label: "Read this", tone: "info" as const }];

describe("workspace interaction", () => {
  it("scopes opaque handles to a workspace and session, and revokes unmounted documents", () => {
    const f = fixture();
    expect(f.workspace.snapshot({ ...f.scope, sessionId: "two" }).documents).toEqual([]);
    expect(() => f.workspace.read({ ...f.scope, workspaceName: "b" }, f.document.id, 1)).toThrow(
      "no longer available",
    );
    expect(f.workspace.read(f.scope, f.document.id, 1).text).toContain("const a");
    f.unregister();
    expect(() => f.workspace.read(f.scope, f.document.id, 1)).toThrow("no longer available");
  });
  it("rejects stale edits and model replacements even when Monaco resets its version", () => {
    const f = fixture();
    f.workspace.annotate("app", f.scope, f.document.id, 1, notes);
    f.listeners.get("edit")!();
    expect(f.layers[0].clear).toHaveBeenCalled();
    expect(() => f.workspace.reveal(f.scope, f.document.id, 1, range)).toThrow("changed");
    expect(f.workspace.snapshot(f.scope).documents[0].version).toBe(2);
    f.listeners.get("model")!();
    expect(() => f.workspace.read(f.scope, f.document.id, 2)).toThrow("changed");
    f.unregister();
  });
  it("clears only an owner's decorations and validates ranges before mutating the editor", () => {
    const f = fixture();
    f.workspace.annotate("one", f.scope, f.document.id, 1, notes);
    f.workspace.annotate("two", f.scope, f.document.id, 1, notes);
    f.workspace.clearOwner("one");
    expect(f.layers[0].clear).toHaveBeenCalledOnce();
    expect(f.layers[1].clear).not.toHaveBeenCalled();
    expect(() => f.workspace.reveal(f.scope, f.document.id, 1, { ...range, endLine: 99 })).toThrow(
      "outside",
    );
    expect(f.view.revealRangeInCenter).not.toHaveBeenCalled();
    f.workspace.reveal(f.scope, f.document.id, 1, range);
    expect(f.view.focus).not.toHaveBeenCalled();
    f.unregister();
  });
});
