import { describe, expect, it, vi } from "vitest";

import type { AppNotice, AppNoticeSeverity, AppNoticeSource } from "./appNotice";
import { getAppNoticeSnapshot } from "./appNotice";

function notice(
  id: string,
  severity: AppNoticeSeverity,
  source: AppNoticeSource,
  overrides: Partial<AppNotice> = {},
): AppNotice {
  return {
    id,
    severity,
    source,
    icon: "info",
    title: id,
    body: `${id} body`,
    ...overrides,
  };
}

describe("app notice coordinator", () => {
  it("orders severity tiers and explicit source priorities deterministically", () => {
    const snapshot = getAppNoticeSnapshot([
      notice("update-info", "info", "update"),
      notice("normal-error", "danger", "update"),
      notice("mcp-error", "danger", "mcp"),
      notice("auth", "blocking", "auth"),
      notice("forced", "blocking", "force-update"),
      notice("encryption", "danger", "encryption-reset"),
      notice("update-action", "action", "update"),
      notice("mcp-action", "action", "mcp"),
    ]);

    expect(snapshot.notices.map(({ id }) => id)).toEqual([
      "forced",
      "auth",
      "encryption",
      "mcp-error",
      "normal-error",
      "mcp-action",
      "update-action",
      "update-info",
    ]);
  });

  it("uses stable source order for same-severity notices instead of timestamps", () => {
    const first = notice("first-update", "info", "update");
    const second = notice("second-update", "info", "update");

    expect(getAppNoticeSnapshot([first, second]).notices).toEqual([first, second]);
    expect(getAppNoticeSnapshot([first, second]).notices).toEqual([first, second]);
  });

  it("suppresses normal update notices while a force update is in progress", () => {
    const normal = notice("normal", "danger", "update");
    const forced = notice("forced", "active", "force-update");
    const snapshot = getAppNoticeSnapshot([normal, forced], { forceUpdateInProgress: true });

    expect(snapshot.notices).toEqual([forced]);
  });

  it("promotes the next notice immediately after the primary is removed", () => {
    const primary = notice("primary", "blocking", "auth");
    const next = notice("next", "danger", "mcp");

    expect(getAppNoticeSnapshot([primary, next]).primary).toBe(primary);
    expect(getAppNoticeSnapshot([null, next]).primary).toBe(next);
  });

  it("reports the number of notices beyond the primary", () => {
    const snapshot = getAppNoticeSnapshot([
      notice("one", "blocking", "auth"),
      notice("two", "danger", "mcp"),
      notice("three", "info", "update"),
    ]);

    expect(snapshot.additionalCount).toBe(2);
  });

  it("keeps dismiss and action callbacks isolated to their source notice", () => {
    const firstAction = vi.fn<() => void>();
    const firstDismiss = vi.fn<() => void>();
    const secondAction = vi.fn<() => void>();
    const snapshot = getAppNoticeSnapshot([
      notice("first", "danger", "encryption-reset", {
        actions: [{ id: "first-action", label: "First", onAction: firstAction }],
        dismiss: { onDismiss: firstDismiss },
      }),
      notice("second", "danger", "mcp", {
        actions: [{ id: "second-action", label: "Second", onAction: secondAction }],
      }),
    ]);

    void snapshot.notices[0].actions?.[0]?.onAction();
    snapshot.notices[0].dismiss?.onDismiss();

    expect(firstAction).toHaveBeenCalledOnce();
    expect(firstDismiss).toHaveBeenCalledOnce();
    expect(secondAction).not.toHaveBeenCalled();
  });

  it("does not rotate the primary between reads", () => {
    const notices = [
      notice("auth", "blocking", "auth"),
      notice("encryption", "danger", "encryption-reset"),
    ];

    const primaryIds = Array.from({ length: 5 }, () => getAppNoticeSnapshot(notices).primary?.id);
    expect(primaryIds).toEqual(["auth", "auth", "auth", "auth", "auth"]);
  });
});
