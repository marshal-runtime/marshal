import type { RuntimeUiScope } from "@common/runtime-ui";
import type { UiDocumentSnapshot, UiSourceRange, UiWorkspaceSnapshot } from "@marshal/runtime/ui";
import type { editor, IRange } from "monaco-editor";

const range = (value: IRange): UiSourceRange => ({
  startLine: value.startLineNumber,
  startColumn: value.startColumn,
  endLine: value.endLineNumber,
  endColumn: value.endColumn,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid document range.");
  return value;
}

/** Native editor handles never confer access to another workspace or session. */
export class WorkspaceInteraction {
  private revision = 0;
  private documents = new Map<
    string,
    {
      scope: RuntimeUiScope;
      path: string;
      version: number;
      editor: editor.IStandaloneCodeEditor;
      layers: Map<string, editor.IEditorDecorationsCollection>;
    }
  >();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  private changed = () => {
    this.revision++;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const listener of this.listeners) listener();
    }, 80);
  };

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  register(scope: RuntimeUiScope, path: string, view: editor.IStandaloneCodeEditor) {
    const id = crypto.randomUUID();
    const entry = {
      scope,
      path,
      version: 1,
      editor: view,
      layers: new Map<string, editor.IEditorDecorationsCollection>(),
    };
    this.documents.set(id, entry);
    const clear = () => {
      for (const layer of entry.layers.values()) layer.clear();
      entry.layers.clear();
    };
    const subscriptions = [
      view.onDidChangeCursorSelection(this.changed),
      view.onDidScrollChange(this.changed),
      view.onDidFocusEditorText(this.changed),
      view.onDidBlurEditorText(this.changed),
      view.onDidChangeModel(() => {
        entry.version++;
        clear();
        this.changed();
      }),
      view.onDidChangeModelContent(() => {
        entry.version++;
        clear();
        this.changed();
      }),
    ];
    this.changed();
    return () => {
      clear();
      subscriptions.forEach((sub) => sub.dispose());
      this.documents.delete(id);
      this.changed();
    };
  }

  private visibleTo(scope: RuntimeUiScope, target: RuntimeUiScope) {
    return (
      scope.workspaceName === target.workspaceName &&
      (target.applicationScope === "workspace" || scope.sessionId === target.sessionId)
    );
  }

  snapshot(scope: RuntimeUiScope): UiWorkspaceSnapshot {
    const documents: UiDocumentSnapshot[] = [];
    for (const [id, entry] of this.documents) {
      const model = entry.editor.getModel();
      if (!model || !this.visibleTo(scope, entry.scope)) continue;
      const selection = entry.editor.getSelection();
      documents.push({
        id,
        path: entry.path,
        version: entry.version,
        language: model.getLanguageId(),
        selection: selection ? range(selection) : null,
        visibleRanges: entry.editor.getVisibleRanges().map(range),
        focused: entry.editor.hasTextFocus(),
        visible: Boolean(entry.editor.getDomNode()?.getClientRects().length),
      });
    }
    return { revision: this.revision, documents: documents.slice(0, 100) };
  }

  private resolve(scope: RuntimeUiScope, id: unknown, version: unknown) {
    const entry = typeof id === "string" ? this.documents.get(id) : undefined;
    const model = entry?.editor.getModel();
    if (!entry || !model || !this.visibleTo(scope, entry.scope))
      throw new Error("Document is no longer available in this session.");
    if (entry.version !== version)
      throw new Error("Document changed. Read a fresh workspace snapshot.");
    return { entry, model };
  }

  read(scope: RuntimeUiScope, id: unknown, version: unknown) {
    const { entry, model } = this.resolve(scope, id, version);
    if (model.getValueLength() > 256_000)
      throw new Error("Document exceeds the 256 KB interaction limit.");
    return { text: model.getValue(), version: entry.version };
  }

  private checkedRange(model: editor.ITextModel, value: unknown): IRange {
    if (!isRecord(value)) throw new Error("Invalid document range.");
    const requested = {
      startLineNumber: positiveInteger(value.startLine),
      startColumn: positiveInteger(value.startColumn),
      endLineNumber: positiveInteger(value.endLine),
      endColumn: positiveInteger(value.endColumn),
    };
    const valid = model.validateRange(requested);
    if (
      requested.startLineNumber !== valid.startLineNumber ||
      requested.startColumn !== valid.startColumn ||
      requested.endLineNumber !== valid.endLineNumber ||
      requested.endColumn !== valid.endColumn
    )
      throw new Error("Range is outside the current document.");
    return requested;
  }

  reveal(scope: RuntimeUiScope, id: unknown, version: unknown, value: unknown, focus?: boolean) {
    const { entry, model } = this.resolve(scope, id, version);
    const target = this.checkedRange(model, value);
    entry.editor.revealRangeInCenter(target);
    entry.editor.setSelection(target);
    if (focus === true) entry.editor.focus();
    return { applied: true, version: entry.version };
  }

  annotate(
    owner: string,
    scope: RuntimeUiScope,
    id: unknown,
    version: unknown,
    annotations: unknown,
  ) {
    const { entry, model } = this.resolve(scope, id, version);
    if (!Array.isArray(annotations) || annotations.length > 100)
      throw new Error("At most 100 annotations are allowed.");
    const decorations = annotations.map((note: unknown) => {
      if (
        !isRecord(note) ||
        typeof note.id !== "string" ||
        note.id.length > 128 ||
        typeof note.label !== "string" ||
        note.label.length > 300 ||
        (note.detail !== undefined &&
          (typeof note.detail !== "string" || note.detail.length > 4000)) ||
        typeof note.tone !== "string" ||
        !["info", "positive", "warning", "muted"].includes(note.tone)
      )
        throw new Error("Invalid annotation.");
      return {
        range: this.checkedRange(model, note.range),
        options: {
          isWholeLine: true,
          className: `marshal-annotation-${note.tone}-line`,
          linesDecorationsClassName: `marshal-annotation-${note.tone}-gutter`,
          hoverMessage: {
            value: `${note.label}\n\n${note.detail ?? ""}`,
            isTrusted: false,
            supportHtml: false,
          },
          after: {
            content: `  ${note.label}`,
            inlineClassName: `marshal-annotation-${note.tone}-label`,
          },
        },
      };
    });
    let layer = entry.layers.get(owner);
    if (!layer) {
      layer = entry.editor.createDecorationsCollection();
      entry.layers.set(owner, layer);
    }
    layer.set(decorations);
    return { applied: true, version: entry.version, count: decorations.length };
  }

  clearOwner(owner: string) {
    for (const entry of this.documents.values()) {
      entry.layers.get(owner)?.clear();
      entry.layers.delete(owner);
    }
  }
}

export const workspaceInteraction = new WorkspaceInteraction();
