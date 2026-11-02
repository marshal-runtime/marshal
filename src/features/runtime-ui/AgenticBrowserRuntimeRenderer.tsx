import type { RuntimeUiJsonValue } from "@common/runtime-ui";
import { AGENTIC_BROWSER_RENDER_ID } from "@common/runtime-ui-renderers";

import { Badge } from "@/components/marshal-ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import type { RuntimeUiApplicationRenderer } from "./RuntimeUiApplicationRegistry";

type BrowserStatus = "active" | "completed" | "failed" | "navigating" | "waiting";

function text(
  state: Readonly<Record<string, RuntimeUiJsonValue>>,
  key: string,
): string | undefined {
  const value = state[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function statusValue(value: string | undefined): BrowserStatus {
  return value === "completed" ||
    value === "failed" ||
    value === "navigating" ||
    value === "waiting"
    ? value
    : "active";
}

function screenshot(
  state: Readonly<Record<string, RuntimeUiJsonValue>>,
): { readonly mimeType: string; readonly data: string } | undefined {
  const value = state.screenshot;
  if (!isRecord(value)) return undefined;
  const mimeType = value.mimeType;
  const data = value.data;
  if (
    (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") ||
    typeof data !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    return undefined;
  }
  return { mimeType, data };
}

function isRecord(
  value: RuntimeUiJsonValue | undefined,
): value is { readonly [key: string]: RuntimeUiJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusVariant(status: BrowserStatus): "default" | "destructive" | "secondary" {
  if (status === "failed") return "destructive";
  if (status === "completed") return "secondary";
  return "default";
}

// oxlint-disable-next-line react/only-export-components
export const agenticBrowserRuntimeUiRenderer: RuntimeUiApplicationRenderer = ({ instance }) => {
  if (
    instance.content.kind !== "application" ||
    instance.content.renderId !== AGENTIC_BROWSER_RENDER_ID
  ) {
    return null;
  }
  const state = instance.content.state ?? {};
  const status = statusValue(text(state, "status"));
  const title = text(state, "title");
  const url = text(state, "url");
  const command = text(state, "command");
  const accessibility = text(state, "accessibility");
  const error = text(state, "error");
  const image = screenshot(state);

  return (
    <div className="grid gap-3" data-testid="marshal-browser-panel">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant(status)}>{status}</Badge>
        {command && <span className="text-xs text-muted-foreground">{command}</span>}
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{title ?? "Browser session"}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {url ? (
            <p className="text-xs break-all text-muted-foreground" data-testid="browser-panel-url">
              {url}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Waiting for page details.</p>
          )}
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {image && (
        <img
          className="w-full rounded-lg border border-border"
          src={`data:${image.mimeType};base64,${image.data}`}
          alt={title ? `Screenshot of ${title}` : "Current browser screenshot"}
          data-testid="browser-panel-screenshot"
        />
      )}

      {accessibility && (
        <section aria-label="Page accessibility snapshot">
          <h3 className="mb-2 text-xs font-medium">Accessibility snapshot</h3>
          <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
            {accessibility}
          </pre>
        </section>
      )}
    </div>
  );
};
