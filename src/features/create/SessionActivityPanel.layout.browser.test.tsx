import type { RuntimeUiAPI, SessionMetadata } from "@common/marshal-ipc-contract";
import type { RuntimeUiInstance, RuntimeUiScope } from "@common/runtime-ui";
import { expect, it, vi } from "vitest";

import { RuntimeUiHost } from "@/features/runtime-ui/RuntimeUiHost";
import { installMockAPIs, render, screen, waitFor } from "@/test-utils";

import { SessionActivityPanel } from "./SessionActivityPanel";

// F-R1 regression (review lens 1 on the D1 lane, planner-triaged; Codex disposition
// 2026-09-09 22:48 elevates this to required-before-deployment). Renders the REAL
// SessionActivityPanel component — not a simulated block-flow container — mounted the
// way it actually is in the app: as a child of RuntimeUiHost (so it inherits the real
// editor context and a real RuntimeUiModel built from window.runtimeUiAPI, exactly as
// production does), with a panel-surface packaged-application instance already open.
// SessionActivityPanel auto-selects the newest panel instance as evidence and renders
// it via RuntimeUiRenderer inside its evidence-detail ScrollArea (SessionActivityPanel.tsx
// lines 616-637) — a block-flow ancestor with no flex/definite-height chain to the
// iframe. Before this repair, PackagedRuntimeUiRenderer inferred fill-vs-floor from
// instance.surface !== "inline-card", so this panel-surface embedding collapsed to 0px
// instead of keeping the pre-F-004 320px floor.

const owner = {
  sessionId: "root",
  workspaceName: "Workspace One",
  extensionId: "fixture.layout",
  applicationId: "tallapp",
};

const instance: RuntimeUiInstance = {
  instanceId: "tallapp-panel-instance",
  owner,
  surface: "panel",
  content: {
    kind: "application",
    renderId: "fixture.layout.tallapp",
    resource: { uri: "ui://fixture/tallapp", mimeType: "text/html", name: "Tall app" },
    descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
  },
  idempotencyKey: "open-tallapp-panel",
  revision: 1,
  openedAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  focusedAt: "2026-09-09T00:00:00.000Z",
};

function tallApplicationHtml(): string {
  return (
    "<style>html,body{margin:0}main{position:relative;height:1600px;background:linear-gradient(#ddd,#777)}#bottom{position:absolute;top:1560px}</style>" +
    '<main><p>Top of tall app</p><div id="bottom">Bottom sentinel</div></main>' +
    "<script>" +
    "parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{}},'*');" +
    "addEventListener('message',function(event){" +
    "if(event.data&&event.data.id===1){parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');}" +
    "});" +
    "</script>"
  );
}

// Same rationale as RuntimeUiApplicationWorkspace.layout.browser.test.tsx: the unit/browser
// vitest projects run with css:false, so this defines the small, stable subset of Tailwind
// v4 utilities the audited components rely on (SessionActivityPanel's rail-layout evidence
// panel chain plus the packaged renderer) as a real stylesheet. Cosmetic-only utilities
// (color, radius, blur, borders) are omitted — irrelevant to the height chain under test.
const LAYOUT_UTILITY_CSS = `
  .flex{display:flex}
  .flex-col{flex-direction:column}
  .flex-1{flex:1 1 0%}
  .min-h-0{min-height:0px}
  .min-h-80{min-height:20rem}
  .size-full{width:100%;height:100%}
  .h-full{height:100%}
  .w-full{width:100%}
  .border-0{border-width:0px}
  .relative{position:relative}
  .absolute{position:absolute}
  .inset-y-4{top:1rem;bottom:1rem}
  .right-4{right:1rem}
  .overflow-hidden{overflow:hidden}
  .p-4{padding:1rem}
  .min-w-0{min-width:0px}
`;

const notImplemented = async (): Promise<never> => {
  throw new Error("Not used by the F-R1 SessionActivityPanel embedding fixture.");
};

function fixture() {
  const snapshot = (scope: RuntimeUiScope) => ({
    success: true as const,
    value: {
      revision: 1,
      generatedAt: instance.openedAt,
      scope,
      instances: [instance],
      events: [],
    },
  });
  const api: RuntimeUiAPI = {
    open: notImplemented,
    update: notImplemented,
    focus: notImplemented,
    close: notImplemented,
    list: notImplemented,
    activatePlacement: notImplemented,
    getSnapshot: vi.fn<RuntimeUiAPI["getSnapshot"]>(async (scope) => snapshot(scope)),
    subscribe: vi.fn<RuntimeUiAPI["subscribe"]>(async (scope) => snapshot(scope)),
    unsubscribe: vi.fn<RuntimeUiAPI["unsubscribe"]>(async () => ({ success: true })),
    onEvent: vi.fn<RuntimeUiAPI["onEvent"]>(() => () => {}),
    getPlacements: vi.fn<RuntimeUiAPI["getPlacements"]>(async () => ({
      revision: 1,
      generatedAt: instance.openedAt,
      diagnostics: [],
      placements: [],
    })),
    invokeCapability: vi.fn<NonNullable<RuntimeUiAPI["invokeCapability"]>>(async () => ({
      success: true,
      value: { output: {} },
    })),
    readResource: vi.fn<NonNullable<RuntimeUiAPI["readResource"]>>(async () => ({
      success: true,
      value: {
        uri: "ui://fixture/tallapp",
        mimeType: "text/html",
        text: tallApplicationHtml(),
        revisionId: "one",
        integrity: "sha256-one",
      },
    })),
    getSelectedSession: vi.fn<NonNullable<RuntimeUiAPI["getSelectedSession"]>>(async () => ({
      success: true,
      value: null,
    })),
    selectSession: vi.fn<NonNullable<RuntimeUiAPI["selectSession"]>>(async () => ({
      success: true,
      value: null,
    })),
    listImages: vi.fn<NonNullable<RuntimeUiAPI["listImages"]>>(async () => ({
      success: true,
      value: [],
    })),
    selectImages: vi.fn<NonNullable<RuntimeUiAPI["selectImages"]>>(async () => ({
      success: true,
      value: [],
    })),
    releaseImage: vi.fn<NonNullable<RuntimeUiAPI["releaseImage"]>>(async () => ({
      success: true,
      value: null,
    })),
  };
  installMockAPIs();
  window.runtimeUiAPI = api;
  return api;
}

it("keeps a usable floor for a panel-surface packaged app in the real SessionActivityPanel evidence detail", async () => {
  const style = document.createElement("style");
  style.textContent = LAYOUT_UTILITY_CSS;
  document.head.appendChild(style);
  fixture();
  const editor = { id: "layout-audit-session-activity", SourceEditor: () => null };
  const sessions: SessionMetadata[] = [
    {
      id: "root",
      name: "Root session",
      createdAt: instance.openedAt,
      updatedAt: instance.openedAt,
      hasUnread: false,
      isActive: true,
      workspaceName: owner.workspaceName,
    },
  ];

  const view = render(
    <div data-testid="pane" style={{ width: 1100, height: 800 }}>
      <RuntimeUiHost activeSessionId="root" sessions={sessions} editor={editor}>
        <SessionActivityPanel sessionId="root" layout="rail" />
      </RuntimeUiHost>
    </div>,
  );

  // SessionActivityPanel auto-selects the newest panel instance as evidence on mount.
  expect(await screen.findByTestId("session-activity-evidence-detail")).toBeInTheDocument();
  const frame = await screen.findByTitle<HTMLIFrameElement>("Tall app");
  await waitFor(() => expect(screen.queryByText(/Loading application/)).toBeNull());

  // Pre-F-004 base behavior was a 320px floor everywhere. SessionActivityPanel's
  // evidence detail never opts into layout="fill" (it calls RuntimeUiRenderer with no
  // layout prop, per SessionActivityPanel.tsx:637), so it must keep that floor rather
  // than collapse toward 0px in this block-flow ScrollArea embedding.
  expect(frame.getBoundingClientRect().height).toBeGreaterThanOrEqual(320);

  view.unmount();
  style.remove();
});
