import type { RuntimeUiApplicationContent, RuntimeUiInstance } from "@common/runtime-ui";
import { AGENTIC_BROWSER_RENDER_ID } from "@common/runtime-ui-renderers";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { agenticBrowserRuntimeUiRenderer } from "./AgenticBrowserRuntimeRenderer";
import type { RuntimeUiApplicationRenderHost } from "./RuntimeUiApplicationRegistry";

function instance(state: NonNullable<RuntimeUiApplicationContent["state"]>) {
  return {
    instanceId: "browser-panel-1",
    owner: {
      sessionId: "session-1",
      workspaceName: "workspace-a",
      extensionId: "@agentic-browser/marshal-runtime-extension",
      applicationId: "browser-session",
    },
    surface: "panel",
    content: {
      kind: "application",
      renderId: AGENTIC_BROWSER_RENDER_ID,
      resource: { uri: "runtime://browser/ui/application/v1", mimeType: "text/html" },
      descriptor: {
        version: "1.0.0",
        presentationModes: ["inline", "pip"],
        actions: [],
        tools: [],
      },
      state,
    },
    idempotencyKey: "browser-session:1",
    revision: 2,
    openedAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:01.000Z",
    focusedAt: "2026-08-20T12:00:01.000Z",
  } satisfies RuntimeUiInstance;
}

const host: RuntimeUiApplicationRenderHost = {
  instance: instance({}),
  editor: {
    id: "test-editor",
    SourceEditor: () => null,
  },
  invokeCapability: async () => {
    throw new Error("not used by browser renderer");
  },
  readResource: async () => {
    throw new Error("not used by browser renderer");
  },
  subscribe: () => () => undefined,
  focus: async () => undefined,
  close: async () => undefined,
  update: async () => undefined,
};

describe("Agentic Browser Runtime panel renderer", () => {
  it("renders browser status and safe page artifacts", () => {
    const target = instance({
      status: "completed",
      command: "browser_navigate",
      url: "https://example.com/",
      title: "Example Domain",
      accessibility: '- heading "Example Domain" [level=1]',
      screenshot: { mimeType: "image/png", data: "aW1hZ2U=" },
    });

    render(<>{agenticBrowserRuntimeUiRenderer({ instance: target, host })}</>);

    expect(screen.getByTestId("marshal-browser-panel")).toHaveTextContent("completed");
    expect(screen.getByText("Example Domain")).toBeInTheDocument();
    expect(screen.getByTestId("browser-panel-url")).toHaveTextContent("https://example.com/");
    expect(screen.getByRole("region", { name: "Page accessibility snapshot" })).toHaveTextContent(
      'heading "Example Domain"',
    );
    expect(screen.getByRole("img", { name: "Screenshot of Example Domain" })).toHaveAttribute(
      "src",
      "data:image/png;base64,aW1hZ2U=",
    );
  });

  it("does not render an unapproved screenshot source", () => {
    const target = instance({
      status: "failed",
      error: "<script>failed</script>",
      screenshot: { mimeType: "image/svg+xml", data: "PHN2Zz4=" },
    });

    render(<>{agenticBrowserRuntimeUiRenderer({ instance: target, host })}</>);

    expect(screen.getByRole("alert")).toHaveTextContent("<script>failed</script>");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
