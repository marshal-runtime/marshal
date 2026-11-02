import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { TelemetryPath_App } from "@/services/telemetry/schema";
import { createCaptureSink, findUserAction, sinkSetup } from "@/services/telemetry/test-utils";
import { installMockAPIs, render, screen, waitFor, userEvent } from "@/test-utils";
import type { SessionsAPI } from "@/types/electron";

import { LeftNav } from "./LeftNav";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

const defaultProps = {
  activeView: "chat" as const,
  onViewChange: vi.fn<(view: string) => void>(),
  onNewChat: vi.fn<() => void>(),
  activeSessionId: null,
  onSessionSelect: vi.fn<(id: string) => void>(),
  onDeleteSession: vi.fn<(id: string) => void>(),
};

function mockSessionList(sessions: Awaited<ReturnType<SessionsAPI["list"]>>["sessions"]) {
  const result = {
    success: true,
    sessions,
    results: undefined,
  };
  return {
    list: vi.fn<SessionsAPI["list"]>().mockResolvedValue(result),
    listWithOptions: vi.fn<SessionsAPI["listWithOptions"]>().mockResolvedValue(result),
  };
}

function renderLeftNav() {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        {/* LeftNav provides its own TelemetryPath_Nav internally */}
        <TelemetryPath_App>
          <LeftNav {...defaultProps} />
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("LeftNav telemetry", () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    events.splice(0);
    vi.clearAllMocks();
    installMockAPIs();
    // Force wide nav so the New Chat button is visible
    originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn<() => void>(),
        removeListener: vi.fn<() => void>(),
        addEventListener: vi.fn<() => void>(),
        removeEventListener: vi.fn<() => void>(),
        dispatchEvent: vi.fn<() => boolean>(),
      }),
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("emits UserAction for NewChat at /App/Nav", async () => {
    const user = userEvent.setup();
    renderLeftNav();
    await user.click(await screen.findByTestId("new-chat-btn"));
    await waitFor(() => {
      expect(findUserAction(events, "NewChat", "/App/Nav")).toBeDefined();
    });
  });

  it("emits UserAction for NavItem at /App/Nav", async () => {
    const user = userEvent.setup();
    renderLeftNav();
    await user.click(await screen.findByTestId("sidebar-account-settings"));
    await waitFor(() => {
      const event = findUserAction(events, "NavItem", "/App/Nav");
      expect(event).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- misc is JSON-stringified onto fields.misc; narrow for the assertion.
      const miscRaw = (event!.fields as Record<string, unknown>).misc;
      expect(typeof miscRaw).toBe("string");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- known shape in tests.
      const misc = JSON.parse(miscRaw as string) as Record<string, unknown>;
      expect(misc.navView).toBe("settings");
    });
  });

  it("emits UserAction for NavItem at /App/Nav from a wide top-rail item with misc.navView", async () => {
    const user = userEvent.setup();
    renderLeftNav();
    await user.click(await screen.findByRole("button", { name: "Orchestration" }));
    await waitFor(() => {
      const event = findUserAction(events, "NavItem", "/App/Nav");
      expect(event).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- misc is JSON-stringified onto fields.misc; narrow for the assertion.
      const miscRaw = (event!.fields as Record<string, unknown>).misc;
      expect(typeof miscRaw).toBe("string");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- known shape in tests.
      const misc = JSON.parse(miscRaw as string) as Record<string, unknown>;
      expect(misc.navView).toBe("automations");
    });
  });

  it("emits UserAction for NavItem at /App/Nav from the narrow account Settings button", async () => {
    // Force narrow nav so the compact account Settings path is exercised.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: vi.fn<() => void>(),
        removeListener: vi.fn<() => void>(),
        addEventListener: vi.fn<() => void>(),
        removeEventListener: vi.fn<() => void>(),
        dispatchEvent: vi.fn<() => boolean>(),
      }),
    });
    const user = userEvent.setup();
    renderLeftNav();
    await user.click(await screen.findByTestId("sidebar-account-settings"));
    await waitFor(() => {
      const event = findUserAction(events, "NavItem", "/App/Nav");
      expect(event).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- misc is JSON-stringified onto fields.misc; narrow for the assertion.
      const miscRaw = (event!.fields as Record<string, unknown>).misc;
      expect(typeof miscRaw).toBe("string");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- known shape in tests.
      const misc = JSON.parse(miscRaw as string) as Record<string, unknown>;
      expect(misc.navView).toBe("settings");
    });
  });

  it("emits UserAction for SessionItem at /App/Nav/NavSessionItem", async () => {
    const user = userEvent.setup();
    installMockAPIs({
      sessionsAPI: {
        ...mockSessionList([
          {
            id: "sess-1",
            name: "Test Session",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
          },
        ]),
      },
    });
    renderLeftNav();
    await user.click(await screen.findByTestId("session-item"));
    await waitFor(() => {
      expect(findUserAction(events, "SessionItem", "/App/Nav/NavSessionItem")).toBeDefined();
    });
  });

  it("emits UserAction for DragToPopout at /App/Nav/NavSessionItem", async () => {
    // Pins that the DragToPopout hook captures the NavSessionItem path context,
    // not /App/Nav. The instrumented callback is shared between the drag and
    // the overflow-menu paths, so exercising the menu path here is sufficient —
    // both call sites read the same telemetry context.
    const user = userEvent.setup();
    installMockAPIs({
      sessionsAPI: {
        list: vi.fn<SessionsAPI["list"]>().mockResolvedValue({
          success: true,
          sessions: [
            {
              id: "sess-1",
              name: "Test Session",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              hasUnread: false,
              isActive: false,
            },
          ],
        }),
      },
    });
    render(
      <TelemetryProvider>
        <RenderScenarioProvider view="chat">
          <TelemetryPath_App>
            <LeftNav {...defaultProps} onOpenSessionInNewWindow={vi.fn<(id: string) => void>()} />
          </TelemetryPath_App>
        </RenderScenarioProvider>
      </TelemetryProvider>,
    );
    const moreBtn = await screen.findByRole("button", { name: "More actions" });
    await user.click(moreBtn);
    await user.click(await screen.findByRole("menuitem", { name: /Open in New Window/ }));
    await waitFor(() => {
      expect(findUserAction(events, "DragToPopout", "/App/Nav/NavSessionItem")).toBeDefined();
    });
  });

  it("emits UserAction for DeleteSession at /App/Nav/NavSessionItem", async () => {
    const user = userEvent.setup();
    installMockAPIs({
      sessionsAPI: {
        ...mockSessionList([
          {
            id: "sess-1",
            name: "Test Session",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
          },
        ]),
      },
    });
    renderLeftNav();
    // Open overflow menu and click Delete
    const moreBtn = await screen.findByRole("button", { name: "More actions" });
    await user.click(moreBtn);
    const deleteItem = await screen.findByRole("menuitem", { name: /Delete/ });
    await user.click(deleteItem);
    // Confirm deletion in dialog
    const confirmBtn = await screen.findByRole("button", { name: "Delete" });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(findUserAction(events, "DeleteSession", "/App/Nav/NavSessionItem")).toBeDefined();
    });
  });
});
