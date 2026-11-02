import Editor, { loader } from "@monaco-editor/react";
import type * as MonacoType from "monaco-editor";
import * as monaco from "monaco-editor";

import "./commands/monaco-completions"; // registers Monaco completion provider as side-effect

// Use locally bundled Monaco instead of CDN
loader.config({ monaco });

// ── Stable option objects (avoid re-render churn) ─────────────
const EDITOR_OPTIONS: MonacoType.editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  fontSize: 13,
  lineHeight: 20,
  wordWrap: "on",
  scrollBeyondLastLine: false,
  automaticLayout: true,
};

// ── Public props ──────────────────────────────────────────────
export interface MonacoEditorProps {
  value: string;
  language: string;
  theme: "light" | "dark";
  /** data-testid placed on the wrapper section */
  testId: string;
  path?: string;
  height?: string;
  width?: string;
  readOnly?: boolean;
  options?: MonacoType.editor.IStandaloneEditorConstructionOptions;
  onChange?: (value: string | undefined) => void;
  /** Called once the editor instance is available; use to save/restore scroll. */
  onMount?: (editor: MonacoType.editor.IStandaloneCodeEditor) => void;
}

export function MonacoEditor({
  value,
  language,
  theme,
  testId,
  path,
  height = "100%",
  width = "100%",
  readOnly = false,
  options,
  onChange,
  onMount,
}: MonacoEditorProps) {
  const monacoTheme = theme === "dark" ? "vs-dark" : "vs";

  return (
    <Editor
      wrapperProps={{ "data-testid": testId }}
      path={path}
      height={height}
      width={width}
      language={language}
      theme={monacoTheme}
      value={value}
      onChange={onChange}
      options={{ ...EDITOR_OPTIONS, ...options, ...(readOnly ? { readOnly: true } : {}) }}
      onMount={onMount}
    />
  );
}
