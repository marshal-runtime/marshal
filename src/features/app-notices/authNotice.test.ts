import { describe, expect, it, vi } from "vitest";

import { buildAuthNotice } from "./authNotice";

describe("buildAuthNotice", () => {
  it("uses concise Copilot expired-session copy for rejected access", () => {
    const notice = buildAuthNotice({
      error: "HTTP 401 Unauthorized",
      runtimeId: "copilot",
      onSignOut: vi.fn<() => void>(),
    });

    expect(notice.title).toBe("Copilot sign-in expired");
    expect(notice.body).toBe("Reconnect to keep using Marshal.");
    expect(notice.severity).toBe("blocking");
  });

  it("uses runtime-specific expired-session copy", () => {
    const notice = buildAuthNotice({
      error: "403 access denied",
      runtimeId: "claude",
      onSignOut: vi.fn<() => void>(),
    });

    expect(notice.title).toBe("Claude Agent sign-in expired");
    expect(notice.body).toBe("Reconnect to keep using Marshal.");
  });

  it("keeps generic connection errors available as notice details", () => {
    const notice = buildAuthNotice({
      error: "Connection failed: runtime unavailable",
      runtimeId: "copilot",
      onSignOut: vi.fn<() => void>(),
    });

    expect(notice.title).toBe("Copilot connection failed");
    expect(notice.body).toBe("Sign out and reconnect to keep using Marshal.");
    expect(notice.details).toBe("Connection failed: runtime unavailable");
  });

  it("preserves the exact sign-out callback", () => {
    const onSignOut = vi.fn<() => void>();
    const notice = buildAuthNotice({
      error: "unauthorized",
      runtimeId: "copilot",
      onSignOut,
    });

    void notice.actions?.[0]?.onAction();
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
