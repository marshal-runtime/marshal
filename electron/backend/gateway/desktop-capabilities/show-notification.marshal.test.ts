// Marshal-owned test
import { describe, expect, it, vi } from "vitest";

import type { NotificationRequest } from "../../types";
import { makeShowNotificationHandler } from "./show-notification";

type SendFn = (title: string, body: string, onClick?: () => void) => void;
type OpenSessionFn = (sessionId: string) => void;

describe("makeShowNotificationHandler", () => {
  it("forwards title and body to sendOSNotification", async () => {
    const send = vi.fn<SendFn>();
    const handler = makeShowNotificationHandler({ sendOSNotification: send });
    const request: NotificationRequest = { title: "Hello", body: "World" };

    await handler(request);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Hello", "World", undefined);
  });

  it("does not pass an onClick callback when onClickAction is absent", async () => {
    const send = vi.fn<SendFn>();
    const onSessionOpenRequested = vi.fn<OpenSessionFn>();
    const handler = makeShowNotificationHandler({
      sendOSNotification: send,
      onSessionOpenRequested,
    });
    const request: NotificationRequest = { title: "Hi", body: "Body" };

    await handler(request);

    expect(send).toHaveBeenCalledWith("Hi", "Body", undefined);
    expect(onSessionOpenRequested).not.toHaveBeenCalled();
  });

  it("invokes onSessionOpenRequested(sessionId) when the user clicks a notification with onClickAction", async () => {
    const send = vi.fn<SendFn>();
    const onSessionOpenRequested = vi.fn<OpenSessionFn>();
    const handler = makeShowNotificationHandler({
      sendOSNotification: send,
      onSessionOpenRequested,
    });
    const request: NotificationRequest = {
      title: "Done",
      body: "Click to open",
      onClickAction: { type: "openSession", sessionId: "session-123" },
    };

    await handler(request);

    const onClick = send.mock.calls[0][2];
    expect(onClick).toBeDefined();
    expect(onSessionOpenRequested).not.toHaveBeenCalled();
    onClick!();
    expect(onSessionOpenRequested).toHaveBeenCalledWith("session-123");
  });

  it("does not pass onClick when onClickAction is set but onSessionOpenRequested is missing", async () => {
    const send = vi.fn<SendFn>();
    const handler = makeShowNotificationHandler({ sendOSNotification: send });
    const request: NotificationRequest = {
      title: "Done",
      body: "Click to open",
      onClickAction: { type: "openSession", sessionId: "session-123" },
    };

    await handler(request);

    expect(send).toHaveBeenCalledWith("Done", "Click to open", undefined);
  });

  it("returns a Promise<void>", async () => {
    const send = vi.fn<SendFn>();
    const handler = makeShowNotificationHandler({ sendOSNotification: send });
    const result = handler({ title: "t", body: "b" });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });
});
