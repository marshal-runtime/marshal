import type { RuntimeUiAPI, SessionMetadata } from "@common/marshal-ipc-contract";
import {
  RUNTIME_UI_HOST_PLACEMENTS,
  RUNTIME_UI_PLACEMENT,
  RUNTIME_UI_USER_SCOPE,
  type RuntimeUiInstance,
  type RuntimeUiScope,
} from "@common/runtime-ui";
import { expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";

import { RuntimeUiHost } from "./RuntimeUiHost";
import { RuntimeUiApplicationWorkspace } from "./RuntimeUiNavigation";

// OMR2-2 / OMR2-1 (Omer review #2, 2026-09-13): the host pane chrome above a
// packaged application — title + extension-identity strip and the permanently
// docked "Assistant session" strip — ate vertical space on every view. These
// tests drive a real sandboxed app through ui/initialize and pin the two
// behaviors end-to-end: an app that opts in with hostChrome "hidden"/"compact"
// collapses the native header, and the assistant-session picker stays
// off-screen until the app requests a selection (§7: the grant flow still
// runs through the visible, user-performed native picker).

const owner = {
  ...RUNTIME_UI_USER_SCOPE,
  extensionId: "fixture.chrome",
  applicationId: "ownheaderapp",
};

const application = {
  extensionId: owner.extensionId,
  applicationId: owner.applicationId,
  title: "Own-header app",
  description: "Host chrome fixture application",
  renderId: "fixture.chrome.ownheaderapp",
  action: "augment" as const,
};

function instanceFixture(
  surface: RuntimeUiInstance["surface"],
  instanceOwner: RuntimeUiInstance["owner"] = owner,
): RuntimeUiInstance {
  return {
    instanceId: `ownheaderapp-${surface}`,
    owner: instanceOwner,
    surface,
    content: {
      kind: "application",
      renderId: application.renderId,
      resource: { uri: "ui://fixture/ownheaderapp", mimeType: "text/html", name: "Own-header app" },
      descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
    },
    idempotencyKey: `open-ownheaderapp-${surface}`,
    revision: 1,
    openedAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    focusedAt: "2026-09-13T00:00:00.000Z",
  };
}

function applicationHtml(initializeParams: Record<string, unknown>): string {
  return (
    "<main><h1>App-rendered header</h1></main>" +
    "<script>" +
    `parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:${JSON.stringify(initializeParams)}},'*');` +
    "addEventListener('message',function(event){" +
    "if(event.data&&event.data.id===1){parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');}" +
    "if(event.data&&event.data.type==='omr2:request-session'){" +
    "parent.postMessage({jsonrpc:'2.0',id:2,method:'ui/requestSessionSelection',params:{}},'*');" +
    "}" +
    "});" +
    "</script>"
  );
}

const notImplemented = async (): Promise<never> => {
  throw new Error("Not used by the OMR2 chrome fixture.");
};

function fixture(
  instance: RuntimeUiInstance,
  html: string,
  options: { readonly published?: boolean; readonly activeSessionId?: string | null } = {},
) {
  const { published = true, activeSessionId = null } = options;
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
        applications:
          published && metadata.id === RUNTIME_UI_PLACEMENT.NAV_PRIMARY ? [application] : [],
      })),
    })),
    invokeCapability: vi.fn<NonNullable<RuntimeUiAPI["invokeCapability"]>>(async () => ({
      success: true,
      value: { output: {} },
    })),
    readResource: vi.fn<NonNullable<RuntimeUiAPI["readResource"]>>(async () => ({
      success: true,
      value: {
        uri: instance.content.kind === "application" ? instance.content.resource.uri : "",
        mimeType: "text/html",
        text: html,
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
  const editor = { id: "omr2-chrome", SourceEditor: () => null };
  const view = render(
    <RuntimeUiHost activeSessionId={activeSessionId} sessions={sessions} editor={editor}>
      <RuntimeUiApplicationWorkspace>
        <p>Chat workspace</p>
      </RuntimeUiApplicationWorkspace>
    </RuntimeUiHost>,
  );
  return { view };
}

async function appReady(): Promise<HTMLIFrameElement> {
  const frame = await screen.findByTitle<HTMLIFrameElement>("Own-header app");
  await waitFor(() => expect(screen.queryByText(/Loading application/)).toBeNull());
  return frame;
}

it("OMR2-2: suppresses the host title+identity chrome when the app opts in with hostChrome 'hidden'", async () => {
  const { view } = fixture(instanceFixture("tab"), applicationHtml({ hostChrome: "hidden" }));
  await appReady();
  // The app renders its own header; the native title row and the
  // extension-identity strip must retire entirely.
  await waitFor(() => expect(screen.queryByText(owner.extensionId)).toBeNull());
  expect(screen.queryByText(owner.applicationId)).toBeNull();
  expect(screen.queryByRole("button", { name: `Close ${owner.applicationId}` })).toBeNull();
  // OMR2-1: no permanently docked assistant-session strip either.
  expect(screen.queryByRole("combobox", { name: "Assistant session" })).toBeNull();
  view.unmount();
});

it("OMR2-2: collapses to a single compact line when the app opts in with hostChrome 'compact'", async () => {
  const { view } = fixture(instanceFixture("tab"), applicationHtml({ hostChrome: "compact" }));
  await appReady();
  // Compact keeps the title and the close affordance on one slim line but
  // drops the extension-identity strip.
  await waitFor(() => expect(screen.queryByText(owner.extensionId)).toBeNull());
  expect(screen.getByText(application.title)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: `Close ${application.title}` })).toBeInTheDocument();
  view.unmount();
});

it("OMR2-2: keeps the full host chrome for applications that do not opt in", async () => {
  const { view } = fixture(instanceFixture("tab"), applicationHtml({}));
  await appReady();
  expect(screen.getByText(application.title)).toBeInTheDocument();
  expect(screen.getByText(owner.extensionId)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: `Close ${application.title}` })).toBeInTheDocument();
  view.unmount();
});

it("OMR2-1 §7 guard: the assistant-session picker is summoned by the app's ui/requestSessionSelection and stays reachable for the visible grant flow", async () => {
  const { view } = fixture(instanceFixture("tab"), applicationHtml({}));
  const frame = await appReady();
  // Not docked while nothing needs a grant.
  expect(screen.queryByRole("combobox", { name: "Assistant session" })).toBeNull();
  frame.contentWindow!.postMessage({ type: "omr2:request-session" }, "*");
  // The app's request summons the native picker — the §7 grant flow surface.
  expect(await screen.findByRole("combobox", { name: "Assistant session" })).toBeInTheDocument();
  // Summoning alone must not mint a selection.
  expect(window.runtimeUiAPI!.selectSession).not.toHaveBeenCalled();
  view.unmount();
});

it("OMR2-2: a fullscreen dialog surface degrades 'hidden' to compact so the close affordance stays reachable", async () => {
  // Fullscreen dialog frames host session-scoped instances (RuntimeUiHost's
  // own model); user-scope published apps render through the workspace pane.
  const { view } = fixture(
    instanceFixture("fullscreen", {
      sessionId: "session-1",
      workspaceName: "marshal",
      extensionId: owner.extensionId,
      applicationId: owner.applicationId,
    }),
    applicationHtml({ hostChrome: "hidden" }),
    { published: false, activeSessionId: "session-1" },
  );
  await appReady();
  await waitFor(() => expect(screen.queryByText(owner.extensionId)).toBeNull());
  expect(screen.getByRole("button", { name: `Close ${application.title}` })).toBeInTheDocument();
  view.unmount();
});
