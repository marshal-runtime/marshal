import { describe, expect, it, vi } from "vitest";

import type { PermissionPolicy } from "../permission-policy";
import type { SessionViewIpcBroker } from "../session-view-ipc-broker";
import { testDouble } from "../testing/harness";
import { registerSessionsHandlers } from "./sessions-ipc";
import type { IpcDeps } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC handler capture mirrors Electron invocation.
type Handler = (...args: any[]) => any;

function captureHandlers(sessionManager: IpcDeps["sessionManager"]): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const ipcHandle = vi.fn<(channel: string, handler: Handler) => void>((channel, handler) => {
    handlers.set(channel, handler);
  });
  registerSessionsHandlers({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- one capture map represents the generic IPC contract.
    ipcHandle: ipcHandle as unknown as IpcDeps["ipcHandle"],
    sessionManager,
    permissionPolicy: testDouble<PermissionPolicy>({}),
    sessionViewIpcBroker: testDouble<SessionViewIpcBroker>({}),
  });
  return handlers;
}

it("reads phone history through the display path rather than the desktop runtime fence", async () => {
  const getSessionMessagesPage = vi.fn<IpcDeps["sessionManager"]["getSessionMessagesPage"]>(async () => ({
    session: testDouble({ id: "phone-chat", runtimeId: "claude", messages: [] }), total: 0, hasMore: false,
  }));
  const getSessionAsync = vi.fn<IpcDeps["sessionManager"]["getSessionAsync"]>();
  const handlers = captureHandlers(testDouble({ getSessionMessagesPage, getSessionAsync, isSessionBusy: () => false }));
  const handler = handlers.get("sessions:get");
  if (!handler) throw new Error("Missing history handler");
  await expect(handler({}, "phone-chat", { messageLimit: 20 })).resolves.toMatchObject({ success: true, session: { id: "phone-chat" } });
  expect(getSessionMessagesPage).toHaveBeenCalledWith("phone-chat", 20, true);
  expect(getSessionAsync).not.toHaveBeenCalled();
});

describe("sessions:listWithOptions", () => {
  it("uses the bounded page API when pagination options are present", async () => {
    const page = {
      sessions: [
        {
          id: "session-1",
          name: "Session 1",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          hasUnread: false,
          isActive: false,
        },
      ],
      hasMore: true,
      nextCursor: "session-1",
    };
    const listSessionsPage = vi
      .fn<IpcDeps["sessionManager"]["listSessionsPage"]>()
      .mockResolvedValue(page);
    const listSessions = vi.fn<IpcDeps["sessionManager"]["listSessions"]>();
    const handlers = captureHandlers(
      testDouble<IpcDeps["sessionManager"]>({ listSessionsPage, listSessions }),
    );
    const handler = handlers.get("sessions:listWithOptions");
    if (!handler) throw new Error("Missing sessions:listWithOptions handler");
    const options = { includeWorkflowRuns: true, limit: 40, beforeSessionId: "session-0" };

    await expect(handler({}, options)).resolves.toEqual({ success: true, ...page });
    expect(listSessionsPage).toHaveBeenCalledWith(options);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("preserves the unbounded legacy result when no pagination option is requested", async () => {
    const sessions = [
      {
        id: "legacy",
        name: "Legacy caller",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        hasUnread: false,
        isActive: false,
      },
    ];
    const listSessions = vi
      .fn<IpcDeps["sessionManager"]["listSessions"]>()
      .mockResolvedValue(sessions);
    const listSessionsPage = vi.fn<IpcDeps["sessionManager"]["listSessionsPage"]>();
    const handlers = captureHandlers(
      testDouble<IpcDeps["sessionManager"]>({ listSessionsPage, listSessions }),
    );
    const handler = handlers.get("sessions:listWithOptions");
    if (!handler) throw new Error("Missing sessions:listWithOptions handler");

    await expect(handler({}, { includeWorkflowRuns: true })).resolves.toEqual({
      success: true,
      sessions,
    });
    expect(listSessions).toHaveBeenCalledWith({
      includeWorkflowRuns: true,
      sources: undefined,
      excludeSources: undefined,
    });
    expect(listSessionsPage).not.toHaveBeenCalled();
  });
});
