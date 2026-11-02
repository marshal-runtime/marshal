import { editor as MonacoEditorApi } from "monaco-editor";
import { useCallback, useEffect, useRef, type JSX } from "react";

import { MonacoEditor } from "@/features/create/filepreview/MonacoEditor";

import type { MarshalRuntimeEditorSourceProps } from "./RuntimeEditor";

type MountedEditor = MonacoEditorApi.IStandaloneCodeEditor;

function applyDecorations(
  editor: MountedEditor,
  breakpoints: MarshalRuntimeEditorSourceProps["breakpoints"],
  currentLine: number | undefined,
  previous: readonly string[],
): string[] {
  const decorations: MonacoEditorApi.IModelDeltaDecoration[] = breakpoints.map((breakpoint) => ({
    range: {
      startLineNumber: breakpoint.line,
      startColumn: 1,
      endLineNumber: breakpoint.line,
      endColumn: 1,
    },
    options: {
      isWholeLine: false,
      glyphMarginClassName: [
        "adb-breakpoint-glyph",
        breakpoint.origin === "agent" ? "adb-breakpoint-glyph-agent" : "",
        breakpoint.enabled ? "" : "adb-breakpoint-glyph-disabled",
      ]
        .filter(Boolean)
        .join(" "),
      glyphMarginHoverMessage: {
        value: `${breakpoint.origin === "agent" ? "Agent" : "Human"} breakpoint`,
      },
    },
  }));

  if (currentLine !== undefined) {
    decorations.push({
      range: {
        startLineNumber: currentLine,
        startColumn: 1,
        endLineNumber: currentLine,
        endColumn: 1,
      },
      options: {
        isWholeLine: true,
        className: "adb-current-execution-line",
        glyphMarginClassName: "adb-current-execution-glyph",
        glyphMarginHoverMessage: { value: "Current execution line" },
      },
    });
  }

  return editor.deltaDecorations([...previous], decorations);
}

export function MarshalMonacoSourceEditor({
  source,
  breakpoints,
  currentLine,
  theme,
  onToggleBreakpoint,
}: MarshalRuntimeEditorSourceProps): JSX.Element {
  const editorRef = useRef<MountedEditor | null>(null);
  const decorationIdsRef = useRef<readonly string[]>([]);
  const mouseSubscriptionRef = useRef<{ dispose(): void } | null>(null);

  const refreshDecorations = useCallback(() => {
    if (!editorRef.current) return;
    decorationIdsRef.current = applyDecorations(
      editorRef.current,
      breakpoints,
      currentLine,
      decorationIdsRef.current,
    );
    if (currentLine !== undefined) {
      editorRef.current.revealLineInCenterIfOutsideViewport(currentLine);
    }
  }, [breakpoints, currentLine]);

  const handleMount = useCallback(
    (editor: MountedEditor) => {
      editorRef.current = editor;
      mouseSubscriptionRef.current?.dispose();
      mouseSubscriptionRef.current = editor.onMouseDown((event) => {
        const line = event.target.position?.lineNumber;
        if (!line) return;
        if (
          event.target.type === MonacoEditorApi.MouseTargetType.GUTTER_GLYPH_MARGIN ||
          event.target.type === MonacoEditorApi.MouseTargetType.GUTTER_LINE_NUMBERS
        ) {
          onToggleBreakpoint(line);
        }
      });
      refreshDecorations();
    },
    [onToggleBreakpoint, refreshDecorations],
  );

  useEffect(() => {
    refreshDecorations();
  }, [refreshDecorations, source.path]);

  useEffect(
    () => () => {
      mouseSubscriptionRef.current?.dispose();
      if (editorRef.current) {
        editorRef.current.deltaDecorations([...decorationIdsRef.current], []);
      }
      editorRef.current = null;
    },
    [],
  );

  return (
    <MonacoEditor
      testId="runtime-debugger-source-editor"
      path={source.path}
      language={source.language}
      theme={theme}
      value={source.content ?? ""}
      readOnly
      options={{ glyphMargin: true }}
      onChange={() => undefined}
      onMount={handleMount}
    />
  );
}
