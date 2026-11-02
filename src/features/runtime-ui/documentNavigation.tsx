import type { RuntimeUiScope } from "@common/runtime-ui";
import { useState, type ReactNode } from "react";

import { useIsMobile } from "@/shared/hooks/useIsMobile";

import { documentPath } from "./documentPath";
import { WorkspaceDocumentScope } from "./WorkspaceDocumentScope";

export function DocumentLinkScope({
  scope,
  basePath,
  children,
}: {
  scope: RuntimeUiScope | null;
  basePath?: string;
  children: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  // The floating side panel (SessionActivityPanel) has no mobile layout, so
  // route file links to the full-page fullscreen surface on narrow viewports
  // instead — it already renders full-page with a working Close button.
  const isMobile = useIsMobile();
  return (
    <WorkspaceDocumentScope value={scope}>
      <div
        className="contents"
        data-document-base-path={basePath}
        onClickCapture={(event) => {
          const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
          if (!anchor || !scope) return;
          const path = documentPath(
            anchor.getAttribute("href") ?? "",
            anchor.closest("[data-document-base-path]")?.getAttribute("data-document-base-path") ??
              basePath,
          );
          if (!path) return;
          event.preventDefault();
          event.stopPropagation();
          setError(null);
          void window.runtimeUiAPI
            ?.open({
              ...scope,
              extensionId: "marshal.documents",
              applicationId: path.slice(-256),
              surface: isMobile ? "fullscreen" : "panel",
              content: { kind: "file", path },
              idempotencyKey: crypto.randomUUID(),
            })
            .then((result) => {
              if (!result.success) setError(result.error.message);
            })
            .catch((reason) => setError(String(reason)));
        }}
      >
        {children}
        {error && <p role="alert">{error}</p>}
      </div>
    </WorkspaceDocumentScope>
  );
}
