import type { RuntimeUiAPI, SessionMetadata } from "@common/marshal-ipc-contract";
import {
  RUNTIME_UI_HOST_PLACEMENTS,
  RUNTIME_UI_PLACEMENT,
  RUNTIME_UI_USER_SCOPE,
  type RuntimeUiInstance,
  type RuntimeUiScope,
} from "@common/runtime-ui";
import { expect, it, vi } from "vitest";

import { ScrollArea } from "@/components/ui/scroll-area";
import { installMockAPIs, render, screen, waitFor } from "@/test-utils";

import { RuntimeUiHost } from "./RuntimeUiHost";
import { RuntimeUiApplicationWorkspace } from "./RuntimeUiNavigation";
import { RuntimeUiRenderer } from "./RuntimeUiRenderer";

// D1 layout regression (audit: AUDIT-LAYOUT.md, section 1). Renders the real
// RuntimeUiApplicationWorkspace/RuntimeUiInstanceFrame, including native
// session/image picker chrome, around a packaged HTML app whose document is
// far taller than the viewport. Reproduces the pre-fix failure (iframe stuck
// at the 320px min-h-80 floor no matter how tall the native pane is) and then
// proves the fixed behavior: the iframe fills the remaining pane at multiple
// heights, tracks a live pane resize, and its own document can be scrolled to
// a bottom sentinel.

const owner = {
  ...RUNTIME_UI_USER_SCOPE,
  extensionId: "fixture.layout",
  applicationId: "tallapp",
};

const application = {
  extensionId: owner.extensionId,
  applicationId: owner.applicationId,
  title: "Tall app",
  description: "Layout audit fixture application",
  renderId: "fixture.layout.tallapp",
  action: "augment" as const,
};

const instance: RuntimeUiInstance = {
  instanceId: "tallapp-instance",
  owner,
  surface: "tab",
  content: {
    kind: "application",
    renderId: application.renderId,
    resource: { uri: "ui://fixture/tallapp", mimeType: "text/html", name: "Tall app" },
    descriptor: {
      version: "1.0.0",
      presentationModes: ["inline"],
      actions: [],
      tools: [],
      wantsImages: true,
    },
  },
  idempotencyKey: "open-tallapp",
  revision: 1,
  openedAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  focusedAt: "2026-09-09T00:00:00.000Z",
};

// Same content/resource as `instance` (the fixture's readResource stub always
// returns uri "ui://fixture/tallapp" regardless of what's requested) — only
// the surface differs, matching how SessionActivityPanel's evidence detail
// opens panel-surface instances.
const panelEmbeddedInstance: RuntimeUiInstance = {
  ...instance,
  instanceId: "tallapp-panel-instance",
  surface: "panel",
  idempotencyKey: "open-tallapp-panel",
};

function tallApplicationHtml(): string {
  return (
    "<style>html,body{margin:0}main{position:relative;height:1600px;background:linear-gradient(#ddd,#777)}#bottom{position:absolute;top:1560px}</style>" +
    '<main><p>Top of tall app</p><div id="bottom">Bottom sentinel</div></main>' +
    "<script>" +
    "parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{}},'*');" +
    "addEventListener('message',function(event){" +
    "if(event.data&&event.data.id===1){parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');}" +
    "if(event.data&&event.data.type==='layout-audit:probe'){" +
    "var rect=document.getElementById('bottom').getBoundingClientRect();" +
    "parent.postMessage({type:'layout-audit:rect',phase:event.data.phase,top:rect.top,bottom:rect.bottom,viewportHeight:innerHeight},'*');" +
    "}" +
    "if(event.data&&event.data.type==='layout-audit:scroll'){document.getElementById('bottom').scrollIntoView();}" +
    "});" +
    "</script>"
  );
}

// The unit/browser vitest projects run with `css: false` (see vitest.config.ts) so
// Tailwind's compiled utility CSS is never loaded in tests. This regression is about
// the real flex/min-height chain those utilities produce, so this test defines the
// small, stable subset of Tailwind v4's utilities that the audited components rely
// on and injects it as a real stylesheet. Everything else (color, padding, radius)
// is cosmetic and irrelevant to the height chain under test.
const LAYOUT_UTILITY_CSS = `
  .flex{display:flex}
  .flex-col{flex-direction:column}
  .flex-wrap{flex-wrap:wrap}
  .flex-1{flex:1 1 0%}
  .min-h-0{min-height:0px}
  .min-h-10{min-height:2.5rem}
  .min-h-80{min-height:20rem}
  .size-full{width:100%;height:100%}
  .h-full{height:100%}
  .w-full{width:100%}
  .border-0{border-width:0px}
  .relative{position:relative}
  .overflow-hidden{overflow:hidden}
  .contents{display:contents}
`;

function requestSentinelRect(
  frame: HTMLIFrameElement,
  phase: string,
): Promise<{ top: number; bottom: number; viewportHeight: number }> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      if (event.data && event.data.type === "layout-audit:rect" && event.data.phase === phase) {
        window.removeEventListener("message", handler);
        resolve(event.data);
      }
    };
    window.addEventListener("message", handler);
    frame.contentWindow!.postMessage({ type: "layout-audit:probe", phase }, "*");
  });
}

// A zero-argument function returning Promise<never> is structurally assignable to any
// of RuntimeUiAPI's methods (fewer parameters and a bottom return type both satisfy
// variance), so this stands in for the required methods this fixture never calls
// (open/update/focus/close/list/activatePlacement) without a Partial<RuntimeUiAPI> cast.
const notImplemented = async (): Promise<never> => {
  throw new Error("Not used by the D1 layout fixture.");
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
      placements: RUNTIME_UI_HOST_PLACEMENTS.map((metadata) => ({
        metadata,
        applications: metadata.id === RUNTIME_UI_PLACEMENT.NAV_PRIMARY ? [application] : [],
      })),
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
  // Not testDouble() from electron/testing/harness: that module reaches Electron-only
  // auth machinery whose native keytar dependency breaks Vite's browser-mode
  // dependency prebundle.
  window.runtimeUiAPI = api;
  return api;
}

it("fills the remaining native pane with the packaged app's iframe, tracks resize, and reaches a bottom sentinel by scrolling inside it", async () => {
  const style = document.createElement("style");
  style.textContent = LAYOUT_UTILITY_CSS;
  document.head.appendChild(style);
  fixture();
  const editor = { id: "layout-audit", SourceEditor: () => null };
  const sessions: SessionMetadata[] = [
    {
      id: "session-1",
      name: "Driving session",
      createdAt: instance.openedAt,
      updatedAt: instance.openedAt,
      hasUnread: false,
      isActive: true,
    },
  ];
  const view = render(
    <div data-testid="pane" style={{ width: 1100, height: 800 }}>
      <RuntimeUiHost activeSessionId={null} sessions={sessions} editor={editor}>
        <RuntimeUiApplicationWorkspace>
          <p>Chat workspace</p>
        </RuntimeUiApplicationWorkspace>
      </RuntimeUiHost>
    </div>,
  );

  const frame = await screen.findByTitle<HTMLIFrameElement>("Tall app");
  await waitFor(() => expect(screen.queryByText(/Loading application/)).toBeNull());
  // Native image-selection chrome is present around the app; the assistant-
  // session picker is on-demand (OMR2-1) and must NOT be docked by default.
  expect(screen.queryByRole("combobox", { name: "Assistant session" })).toBeNull();
  expect(screen.getByRole("button", { name: "Attach images" })).toBeInTheDocument();

  const pane = screen.getByTestId("pane");
  const nativeFrame = screen.getByTestId("runtime-ui-application-tallapp");
  const measure = () => ({
    paneHeight: pane.getBoundingClientRect().height,
    nativeFrameBottom: nativeFrame.getBoundingClientRect().bottom,
    iframeHeight: frame.getBoundingClientRect().height,
    iframeBottom: frame.getBoundingClientRect().bottom,
  });

  const before = measure();
  pane.style.height = "1050px";
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const after = measure();

  expect(after.paneHeight - before.paneHeight).toBe(250);
  expect(before.iframeHeight).toBeGreaterThan(320);
  expect(after.iframeHeight).toBeGreaterThan(before.iframeHeight);
  expect(after.iframeHeight - before.iframeHeight).toBe(after.paneHeight - before.paneHeight);
  expect(before.nativeFrameBottom - before.iframeBottom).toBeLessThan(1);
  expect(after.nativeFrameBottom - after.iframeBottom).toBeLessThan(1);

  const beforeScroll = await requestSentinelRect(frame, "before-scroll");
  expect(beforeScroll.top).toBeGreaterThan(beforeScroll.viewportHeight);
  frame.contentWindow!.postMessage({ type: "layout-audit:scroll" }, "*");
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const afterScroll = await requestSentinelRect(frame, "after-scroll");
  expect(afterScroll.top).toBeLessThan(afterScroll.viewportHeight);
  expect(afterScroll.bottom).toBeGreaterThan(0);

  view.unmount();
  style.remove();
});

// F-004 regression (Codex, user-confirmed): the tall-pane fix above left a
// fixed min-h-80 (320px) floor on PackagedRuntimeUiRenderer's root div and
// iframe, so panes shorter than 320px of available content still overflowed
// the native frame instead of shrinking to fit. Reproduces at pane heights
// 400 and 300 (available content ~252px / ~152px once native chrome is
// subtracted) and proves the iframe now shrinks to exactly that remaining
// space with no overflow past the native frame, while the bottom sentinel
// stays reachable by scrolling inside the iframe document.
it.each([{ paneHeight: 400 }, { paneHeight: 300 }])(
  "shrinks the packaged app's iframe to fit a short native pane ($paneHeight px) without overflow, and keeps the bottom sentinel reachable",
  async ({ paneHeight }) => {
    const style = document.createElement("style");
    style.textContent = LAYOUT_UTILITY_CSS;
    document.head.appendChild(style);
    fixture();
    const editor = { id: "layout-audit-short", SourceEditor: () => null };
    const sessions: SessionMetadata[] = [
      {
        id: "session-1",
        name: "Driving session",
        createdAt: instance.openedAt,
        updatedAt: instance.openedAt,
        hasUnread: false,
        isActive: true,
      },
    ];
    const view = render(
      <div data-testid="pane" style={{ width: 1100, height: paneHeight }}>
        <RuntimeUiHost activeSessionId={null} sessions={sessions} editor={editor}>
          <RuntimeUiApplicationWorkspace>
            <p>Chat workspace</p>
          </RuntimeUiApplicationWorkspace>
        </RuntimeUiHost>
      </div>,
    );

    const frame = await screen.findByTitle<HTMLIFrameElement>("Tall app");
    await waitFor(() => expect(screen.queryByText(/Loading application/)).toBeNull());

    const nativeFrame = screen.getByTestId("runtime-ui-application-tallapp");
    const nativeFrameRect = nativeFrame.getBoundingClientRect();
    const iframeRect = frame.getBoundingClientRect();

    // The iframe must never extend past the native frame's own bottom edge —
    // this is the exact overflow F-004 reported (min-h-80 pinned it at 320px
    // regardless of how little room the pane actually had).
    expect(iframeRect.bottom).toBeLessThanOrEqual(nativeFrameRect.bottom + 0.5);
    // It should still fill all the room it does have, not shrink further than necessary.
    expect(nativeFrameRect.bottom - iframeRect.bottom).toBeLessThan(1);
    // Below the old 320px floor: proves the floor no longer applies on this bounded-fill path.
    expect(iframeRect.height).toBeLessThan(320);
    expect(iframeRect.height).toBeGreaterThan(0);

    const beforeScroll = await requestSentinelRect(frame, `before-scroll-${paneHeight}`);
    expect(beforeScroll.top).toBeGreaterThan(beforeScroll.viewportHeight);
    frame.contentWindow!.postMessage({ type: "layout-audit:scroll" }, "*");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterScroll = await requestSentinelRect(frame, `after-scroll-${paneHeight}`);
    expect(afterScroll.top).toBeLessThan(afterScroll.viewportHeight);
    expect(afterScroll.bottom).toBeGreaterThan(0);

    view.unmount();
    style.remove();
  },
);

// F-R1 regression (review lens 1 on the D1 lane, planner-triaged): keying the
// F-004 fill-vs-floor choice on `instance.surface !== "inline-card"` made
// PackagedRuntimeUiRenderer assume every non-inline-card embedding sits in
// the same continuous flex/min-h-0 chain RuntimeUiInstanceFrame provides.
// SessionActivityPanel's evidence detail (src/features/create/SessionActivityPanel.tsx)
// opens panel-surface instances directly via RuntimeUiRenderer inside a
// ScrollArea, whose Radix viewport wraps children in a plain block box with
// no flex/definite-height ancestor to the iframe — collapsing it to 0px
// instead of keeping the pre-F-004 320px floor. The fix: layout mode is
// declared by the embedder (RuntimeUiInstanceFrame's bounded content box
// passes layout="fill"); every other embedding, including this one, defaults
// to "natural" and keeps the floor.
it("keeps the natural min-h-80 floor for a panel-surface app embedded in block flow the way SessionActivityPanel embeds it", async () => {
  const style = document.createElement("style");
  style.textContent = `${LAYOUT_UTILITY_CSS}\n.p-4{padding:1rem}\n.min-w-0{min-width:0px}`;
  document.head.appendChild(style);
  fixture();
  const editor = { id: "layout-audit-panel-embed", SourceEditor: () => null };

  const view = render(
    <div data-testid="pane" style={{ width: 1100, height: 800 }}>
      <div className="flex min-h-0 flex-col overflow-hidden" style={{ height: 400 }}>
        <ScrollArea className="min-h-0 flex-1" data-testid="session-activity-scroll">
          <div className="min-w-0 p-4" data-testid="session-activity-evidence-detail">
            <RuntimeUiRenderer instance={panelEmbeddedInstance} editor={editor} />
          </div>
        </ScrollArea>
      </div>
    </div>,
  );

  const frame = await screen.findByTitle<HTMLIFrameElement>("Tall app");
  await waitFor(() => expect(screen.queryByText(/Loading application/)).toBeNull());

  // Pre-F-004 base behavior was a 320px floor; this embedding never opts into
  // layout="fill" (SessionActivityPanel doesn't pass one), so it must keep
  // that floor rather than collapse toward 0px.
  expect(frame.getBoundingClientRect().height).toBeGreaterThanOrEqual(320);

  view.unmount();
  style.remove();
});
