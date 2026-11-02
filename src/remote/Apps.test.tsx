import type { RuntimeUiAPI } from "@common/marshal-ipc-contract";
import {
  RUNTIME_UI_HOST_PLACEMENTS,
  RUNTIME_UI_PLACEMENT,
  RUNTIME_UI_USER_SCOPE,
  type RuntimeUiInstance,
  type RuntimeUiPlacementApplication,
  type RuntimeUiPlacementSnapshot,
  type RuntimeUiSnapshot,
} from "@common/runtime-ui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";

import { RemoteAppPane, RemoteAppsList, useRemoteApplications } from "./Apps";

const owner = {
  ...RUNTIME_UI_USER_SCOPE,
  extensionId: "@marshal/code-review",
  applicationId: "codereview.prs",
};

// Mirrors the installed code-review app's responsive document.
const packagedHtml =
  '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Pull requests</h1></main></body></html>';

function navApplication(
  overrides: Partial<RuntimeUiPlacementApplication> = {},
): RuntimeUiPlacementApplication {
  return {
    extensionId: owner.extensionId,
    applicationId: owner.applicationId,
    title: "Pull Requests",
    description: "Review pull requests from your phone",
    renderId: "codereview-prs",
    action: "augment",
    revisionId: "revision-1",
    viewports: ["mobile", "desktop"],
    ...overrides,
  };
}

function placementSnapshot(
  applications: readonly RuntimeUiPlacementApplication[],
): RuntimeUiPlacementSnapshot {
  return {
    revision: 0,
    generatedAt: "2026-09-13T08:00:00.000Z",
    placements: RUNTIME_UI_HOST_PLACEMENTS.map((metadata) => ({
      metadata,
      applications: metadata.id === RUNTIME_UI_PLACEMENT.NAV_PRIMARY ? [...applications] : [],
    })),
    diagnostics: [],
  };
}

function packagedInstance(): RuntimeUiInstance {
  return {
    instanceId: "instance-1",
    owner,
    surface: "tab",
    idempotencyKey: "remote-navigation:test",
    revision: 1,
    openedAt: "2026-09-13T08:00:00.000Z",
    updatedAt: "2026-09-13T08:00:00.000Z",
    focusedAt: "2026-09-13T08:00:00.000Z",
    content: {
      kind: "application",
      renderId: "codereview-prs",
      resource: { uri: "ui://code-review/prs", mimeType: "text/html", name: "Pull Requests" },
      descriptor: {
        version: "1.0.0",
        presentationModes: ["inline", "fullscreen"],
        actions: [],
        tools: [],
      },
    },
  };
}

function fakeRuntimeUiApi(
  instances: RuntimeUiInstance[],
  applications: readonly RuntimeUiPlacementApplication[],
): RuntimeUiAPI {
  const snapshot = (): RuntimeUiSnapshot => ({
    scope: RUNTIME_UI_USER_SCOPE,
    revision: instances.length,
    generatedAt: "2026-09-13T08:00:00.000Z",
    instances: [...instances],
    events: [],
  });
  const receipt = (instanceId: string) => ({
    receiptId: `receipt-${instanceId}`,
    action: "open" as const,
    status: "applied" as const,
    completedAt: "2026-09-13T08:00:00.000Z",
    revision: 1,
    instanceId,
  });
  const api: Partial<RuntimeUiAPI> = {
    getPlacements: vi.fn<RuntimeUiAPI["getPlacements"]>(async () => placementSnapshot(applications)),
    getSnapshot: vi.fn<RuntimeUiAPI["getSnapshot"]>(async () => ({ success: true as const, value: snapshot() })),
    subscribe: vi.fn<RuntimeUiAPI["subscribe"]>(async () => ({ success: true as const, value: snapshot() })),
    unsubscribe: vi.fn<RuntimeUiAPI["unsubscribe"]>(async () => ({ success: true as const })),
    activatePlacement: vi.fn<NonNullable<RuntimeUiAPI["activatePlacement"]>>(async () => {
      if (instances.length === 0) instances.push(packagedInstance());
      return {
        success: true as const,
        value: {
          receipt: receipt(instances[0].instanceId),
          instance: instances[0],
          instances: [...instances],
        },
      };
    }),
    list: vi.fn<RuntimeUiAPI["list"]>(async () => ({
      success: true as const,
      value: { receipt: receipt("list"), instances: [...instances] },
    })),
    focus: vi.fn<RuntimeUiAPI["focus"]>(async () => ({
      success: true as const,
      value: { receipt: receipt(instances[0]?.instanceId ?? "none"), instance: instances[0] },
    })),
    close: vi.fn<RuntimeUiAPI["close"]>(async () => ({
      success: true as const,
      value: { receipt: receipt("closed") },
    })),
    invokeCapability: vi.fn<NonNullable<RuntimeUiAPI["invokeCapability"]>>(async () => ({ success: true as const, value: { output: {} } })),
    cancelCapability: vi.fn<NonNullable<RuntimeUiAPI["cancelCapability"]>>(async () => ({ success: true as const, value: { cancelled: false } })),
    readResource: vi.fn<NonNullable<RuntimeUiAPI["readResource"]>>(async () => ({
      success: true as const,
      value: {
        uri: "ui://code-review/prs",
        mimeType: "text/html",
        text: packagedHtml,
        revisionId: "revision-1",
        integrity: "sha256-fixture",
      },
    })),
    onEvent: vi.fn<RuntimeUiAPI["onEvent"]>(() => () => {}),
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The fake implements every method the mobile pane exercises.
  return api as RuntimeUiAPI;
}

beforeEach(() => {
  installMockAPIs();
  window.marshalRemote = true;
});

function Applications({ onOpen }: { readonly onOpen: (owner: unknown) => void }) {
  const applications = useRemoteApplications();
  return <RemoteAppsList applications={applications} onOpen={onOpen} />;
}

describe("useRemoteApplications + RemoteAppsList", () => {
  it("lists exactly the applications that publish a mobile view — presence is the signal", async () => {
    window.runtimeUiAPI = fakeRuntimeUiApi(
      [],
      [
        navApplication(),
        navApplication({
          applicationId: "codereview.desktop-dashboard",
          title: "Desktop Dashboard",
          viewports: ["desktop"],
        }),
        navApplication({
          applicationId: "codereview.native",
          title: "Native Renderer App",
          viewports: undefined,
        }),
      ],
    );
    const onOpen = vi.fn<(owner: unknown) => void>();
    render(<Applications onOpen={onOpen} />);
    const entry = await screen.findByRole("button", { name: /Pull Requests/ });
    expect(screen.queryByRole("button", { name: /Desktop Dashboard/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Native Renderer App/ })).toBeNull();
    await userEvent.click(entry);
    expect(onOpen).toHaveBeenCalledWith({
      extensionId: owner.extensionId,
      applicationId: owner.applicationId,
    });
  });

  it("shows an honest empty state when no extension publishes a mobile view", () => {
    render(<RemoteAppsList applications={[]} onOpen={vi.fn<(owner: unknown) => void>()} />);
    expect(screen.getByText(/No extension apps with a phone view yet/i)).toBeInTheDocument();
  });
});

describe("RemoteAppPane", () => {
  it("activates the placement and renders the published UI in a sandboxed frame", async () => {
    const api = fakeRuntimeUiApi([], [navApplication()]);
    window.runtimeUiAPI = api;
    render(
      <RemoteAppPane
        extensionId={owner.extensionId}
        applicationId={owner.applicationId}
        onBack={vi.fn<() => void>()}
      />,
    );
    await waitFor(() => expect(api.activatePlacement).toHaveBeenCalledTimes(1));
    expect(api.activatePlacement).toHaveBeenCalledWith(
      expect.objectContaining({
        ...RUNTIME_UI_USER_SCOPE,
        placementId: RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
        extensionId: owner.extensionId,
        applicationId: owner.applicationId,
      }),
    );
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>(
        "[data-testid=runtime-ui-packaged-frame]",
      );
      if (!element?.getAttribute("srcdoc")) throw new Error("frame not ready");
      return element;
    });
    // Security pin: same sandbox contract as the desktop packaged frame. The
    // frame must never join the remote client's origin (cookies, storage,
    // authenticated fetch) — allow-scripts only.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toContain("Pull requests");
  });

  it("resumes an existing instance without re-activating", async () => {
    const api = fakeRuntimeUiApi([packagedInstance()], [navApplication()]);
    window.runtimeUiAPI = api;
    render(
      <RemoteAppPane
        extensionId={owner.extensionId}
        applicationId={owner.applicationId}
        onBack={vi.fn<() => void>()}
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector("[data-testid=runtime-ui-packaged-frame]"),
      ).toBeInTheDocument(),
    );
    expect(api.activatePlacement).not.toHaveBeenCalled();
  });

  it("returns to the previous view from the pane header", async () => {
    const api = fakeRuntimeUiApi([packagedInstance()], [navApplication()]);
    window.runtimeUiAPI = api;
    const onBack = vi.fn<() => void>();
    render(
      <RemoteAppPane
        extensionId={owner.extensionId}
        applicationId={owner.applicationId}
        onBack={onBack}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
