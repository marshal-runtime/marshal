import type { RuntimeUiScope } from "@common/runtime-ui";
import type { editor } from "monaco-editor";
import { createContext, useContext, useEffect } from "react";

import { workspaceInteraction } from "./workspaceInteraction";

export const WorkspaceDocumentScope = createContext<RuntimeUiScope | null>(null);

export function useWorkspaceDocument(view: editor.IStandaloneCodeEditor | null, path: string) {
  const scope = useContext(WorkspaceDocumentScope);
  const workspaceName = scope?.workspaceName;
  const sessionId = scope?.sessionId;
  const applicationScope = scope?.applicationScope;
  useEffect(() => {
    if (view && workspaceName !== undefined)
      return workspaceInteraction.register(
        { workspaceName, sessionId, applicationScope },
        path,
        view,
      );
    return undefined;
  }, [view, path, workspaceName, sessionId, applicationScope]);
}
