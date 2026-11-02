// oxlint-disable react/only-export-components
import { lazy, Suspense } from "react";

import type { MarshalRuntimeEditor, MarshalRuntimeEditorSourceProps } from "./RuntimeEditor";

// The runtime UI barrel is also imported by phone chat controls. Keep Monaco
// out of that graph until a source editor is actually rendered.
const SourceEditor = lazy(() =>
  import("./MonacoRuntimeSourceEditor").then((module) => ({
    default: module.MarshalMonacoSourceEditor,
  })),
);

function MarshalMonacoSourceEditor(props: MarshalRuntimeEditorSourceProps) {
  return (
    <Suspense fallback={<p role="status">Loading source editor…</p>}>
      <SourceEditor {...props} />
    </Suspense>
  );
}

export const marshalMonacoEditor: MarshalRuntimeEditor = {
  id: "monaco",
  SourceEditor: MarshalMonacoSourceEditor,
};
