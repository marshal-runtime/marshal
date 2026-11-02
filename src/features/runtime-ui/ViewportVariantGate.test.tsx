import type { RuntimeUiInstance } from "@common/runtime-ui";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";

import { PackagedRuntimeUiRenderer } from "./PackagedRuntimeUiRenderer";
import type { RuntimeUiApplicationRenderHost } from "./RuntimeUiApplicationRegistry";

// The wrapper markup is IRRELEVANT to the gate — the runtime stamps a
// responsive viewport meta on every compiled artifact, so activation comes
// only from the deliberate declaration projected onto the resource.
const DOC =
  '<html><head><meta name="viewport" content="width=device-width"></head><body><h1>Card</h1></body></html>';

function sessionInstance(): RuntimeUiInstance {
  return {
    instanceId: "instance-1",
    owner: {
      sessionId: "session-owner",
      workspaceName: "marshal",
      extensionId: "marshal.react-ui",
      applicationId: "card-abc",
    },
    surface: "inline-card",
    idempotencyKey: "open-1",
    revision: 1,
    openedAt: "2026-09-13T08:00:00.000Z",
    updatedAt: "2026-09-13T08:00:00.000Z",
    focusedAt: "2026-09-13T08:00:00.000Z",
    content: {
      kind: "application",
      renderId: "card-abc",
      resource: { uri: "ui://cards/abc", mimeType: "text/html", name: "Status card" },
      descriptor: {
        version: "1.0.0",
        presentationModes: ["inline"],
        actions: [],
        tools: [],
      },
    },
  };
}

function userScopeInstance(): RuntimeUiInstance {
  const instance = sessionInstance();
  return {
    ...instance,
    owner: {
      applicationScope: "user",
      workspaceName: "marshal",
      extensionId: "@marshal/code-review",
      applicationId: "codereview.prs",
    },
  };
}

function host(viewports?: readonly ("mobile" | "desktop")[]): RuntimeUiApplicationRenderHost {
  return {
    instance: sessionInstance(),
    editor: { id: "test", SourceEditor: () => null },
    invokeCapability: vi.fn<RuntimeUiApplicationRenderHost["invokeCapability"]>(async () => ({
      output: {},
    })),
    cancelCapability: vi.fn<NonNullable<RuntimeUiApplicationRenderHost["cancelCapability"]>>(
      async () => {},
    ),
    readResource: vi.fn<RuntimeUiApplicationRenderHost["readResource"]>(async () => ({
      uri: "ui://cards/abc",
      mimeType: "text/html",
      text: DOC,
      revisionId: "revision-1",
      integrity: "sha256-fixture",
      ...(viewports ? { viewports } : {}),
    })),
    subscribe: vi.fn<RuntimeUiApplicationRenderHost["subscribe"]>(() => () => {}),
    focus: vi.fn<RuntimeUiApplicationRenderHost["focus"]>(async () => {}),
    close: vi.fn<RuntimeUiApplicationRenderHost["close"]>(async () => {}),
    update: vi.fn<RuntimeUiApplicationRenderHost["update"]>(async () => {}),
  };
}

describe("viewport variant gate", () => {
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    installMockAPIs();
    send = vi.fn<() => Promise<{ success: boolean }>>(async () => ({ success: true }));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only send is exercised
    window.copilotAPI = { ...window.copilotAPI, send } as typeof window.copilotAPI;
  });
  afterEach(() => {
    delete window.marshalRemote;
    document.documentElement.removeAttribute("data-remote");
  });

  it("renders declared-mobile components on the mobile client", async () => {
    window.marshalRemote = true;
    render(
      <PackagedRuntimeUiRenderer instance={sessionInstance()} host={host(["mobile", "desktop"])} />,
    );
    await waitFor(() =>
      expect(
        document.querySelector("[data-testid=runtime-ui-packaged-frame]")?.getAttribute("srcdoc"),
      ).toContain("Card"),
    );
  });

  it("gates undeclared components on the phone with an error and a mobile-view request — the runtime-stamped responsive meta never activates", async () => {
    window.marshalRemote = true;
    render(<PackagedRuntimeUiRenderer instance={sessionInstance()} host={host()} />);
    const alert = await screen.findByTestId("runtime-ui-viewport-gate");
    expect(alert).toHaveTextContent(/no phone view/i);
    expect(document.querySelector("[data-testid=runtime-ui-packaged-frame]")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /ask for a phone view for this ui/i }),
    );
    // Security pin: the request goes to the OWNING session, nothing else.
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const [prompt, sessionId] = send.mock.calls[0];
    expect(sessionId).toBe("session-owner");
    // The phone's remote policy rejects a send without a client message id.
    expect(send.mock.calls[0]).toHaveLength(4);
    expect(send.mock.calls[0][3]).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    // Agent-authored UI: the request names the one call that adds the view.
    expect(String(prompt)).toContain('runtimeShowUi {instanceId: "instance-1", views: {mobile:');
    expect(String(prompt)).toMatch(/phone layout/i);
  });

  it("shows the symmetric desktop error for declared mobile-only components", async () => {
    render(<PackagedRuntimeUiRenderer instance={sessionInstance()} host={host(["mobile"])} />);
    const alert = await screen.findByTestId("runtime-ui-viewport-gate");
    expect(alert).toHaveTextContent(/no desktop view/i);
    await userEvent.click(
      screen.getByRole("button", { name: /ask for a desktop view for this ui/i }),
    );
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][1]).toBe("session-owner");
    expect(String(send.mock.calls[0][0])).toContain("views: {desktop:");
  });

  it("renders undeclared legacy components on desktop unchanged", async () => {
    render(<PackagedRuntimeUiRenderer instance={sessionInstance()} host={host()} />);
    await waitFor(() =>
      expect(
        document.querySelector("[data-testid=runtime-ui-packaged-frame]")?.getAttribute("srcdoc"),
      ).toContain("Card"),
    );
    expect(screen.queryByTestId("runtime-ui-viewport-gate")).toBeNull();
  });

  it("never gates extension-owned surfaces: presence in the mobile nav is their contract", async () => {
    window.marshalRemote = true;
    const instance = userScopeInstance();
    render(<PackagedRuntimeUiRenderer instance={instance} host={{ ...host(), instance }} />);
    await waitFor(() =>
      expect(
        document.querySelector("[data-testid=runtime-ui-packaged-frame]")?.getAttribute("srcdoc"),
      ).toContain("Card"),
    );
    expect(screen.queryByTestId("runtime-ui-viewport-gate")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
