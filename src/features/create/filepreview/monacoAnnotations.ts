import type * as MonacoType from "monaco-editor";
import { useEffect } from "react";

import type { RuntimeUiDocumentAnnotation } from "../../../../common/runtime-ui";

export type AnnotatedEditor = MonacoType.editor.IStandaloneCodeEditor;

/** Maps extension-supplied annotations onto Monaco decorations, clamped to the model's lines. */
export function annotationDecorations(
  annotations: readonly RuntimeUiDocumentAnnotation[],
  lineCount: number,
): MonacoType.editor.IModelDeltaDecoration[] {
  const decorations: MonacoType.editor.IModelDeltaDecoration[] = [];
  for (const annotation of annotations) {
    if (annotation.startLine > lineCount) continue;
    const startLine = annotation.startLine;
    const endLine = Math.min(annotation.endLine ?? startLine, lineCount);
    const tone = `marshal-annotation-${annotation.tone}`;
    decorations.push({
      range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
      options: {
        isWholeLine: true,
        className: `${tone}-line`,
        linesDecorationsClassName: `${tone}-gutter`,
        hoverMessage: {
          value: annotation.detail
            ? `**${annotation.label}**\n\n${annotation.detail}`
            : annotation.label,
        },
      },
    });
    decorations.push({
      range: {
        startLineNumber: startLine,
        startColumn: Number.MAX_SAFE_INTEGER,
        endLineNumber: startLine,
        endColumn: Number.MAX_SAFE_INTEGER,
      },
      options: {
        after: { content: `  ${annotation.label}`, inlineClassName: `${tone}-label` },
        // The label sits on an empty end-of-line range, which Monaco drops unless told to show it.
        showIfCollapsed: true,
      },
    });
  }
  return decorations;
}

/** Keeps an editor's annotation decorations and reveal line in sync with props. */
export function useMonacoAnnotations(
  editor: AnnotatedEditor | null,
  annotations: readonly RuntimeUiDocumentAnnotation[] | undefined,
  revealLine: number | undefined,
): void {
  useEffect(() => {
    if (!editor || !annotations?.length) return undefined;
    const lineCount = editor.getModel()?.getLineCount() ?? 0;
    const collection = editor.createDecorationsCollection(
      annotationDecorations(annotations, lineCount),
    );
    return () => collection.clear();
  }, [editor, annotations]);

  useEffect(() => {
    if (!editor || revealLine === undefined) return;
    const lineCount = editor.getModel()?.getLineCount() ?? 0;
    if (lineCount === 0) return;
    const line = Math.min(revealLine, lineCount);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
  }, [editor, revealLine]);
}
