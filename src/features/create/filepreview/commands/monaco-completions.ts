import * as monaco from "monaco-editor";

import { createSlashCommands } from "./command-catalog";
import { buildSlashCommandSnippet } from "./snippet-utils";

/**
 * Registers a CompletionItemProvider for the "markdown" language on the
 * statically imported Monaco instance. This module is side-effectful — importing
 * it is enough to install the provider. The same `monaco` import is passed to
 * `loader.config({ monaco })` in FilePreview.tsx, so this is guaranteed to be
 * the instance that `@monaco-editor/react` uses.
 *
 * Trigger completions via Ctrl+Space in the Monaco source editor.
 *
 * Guard against duplicate registration during HMR / hot reload.
 */
if (!(globalThis as Record<string, unknown>).__monacoSlashRegistered) {
  (globalThis as Record<string, unknown>).__monacoSlashRegistered = true;

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      (globalThis as Record<string, unknown>).__monacoSlashRegistered = false;
    });
  }

  monaco.languages.registerCompletionItemProvider("markdown", {
    provideCompletionItems(model, position) {
      // Only suggest on empty lines or lines that start with "/"
      const lineText = model.getLineContent(position.lineNumber);
      const textBeforeCursor = lineText.slice(0, position.column - 1).trimStart();
      if (textBeforeCursor !== "" && !textBeforeCursor.startsWith("/")) {
        return { suggestions: [] };
      }

      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        textBeforeCursor.startsWith("/") ? word.startColumn - 1 : word.startColumn,
        position.lineNumber,
        word.endColumn,
      );

      const suggestions: monaco.languages.CompletionItem[] = createSlashCommands
        .filter((cmd) => cmd.id !== "comment")
        .map((cmd, idx) => ({
          label: cmd.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: cmd.keywords.join(", "),
          documentation: typeof cmd.markdown === "string" ? cmd.markdown : cmd.markdown.join("\n"),
          insertText: buildSlashCommandSnippet(cmd.id, cmd.markdown),
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: String(idx).padStart(3, "0"),
        }));

      return { suggestions };
    },
  });
}
