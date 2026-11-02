import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { surfaceCompletedRestartsOnBoot, type AppRestartBootDeps } from "./app-restart-boot";
import { readRestartLedgerEntries, recordPendingRestartSync } from "./app-restart-ledger";

function makeDeps(
  dir: string,
  overrides: Partial<AppRestartBootDeps> = {},
): {
  deps: AppRestartBootDeps;
  appendSystemNotice: Mock<AppRestartBootDeps["appendSystemNotice"]>;
  enqueueWakeMessage: Mock<AppRestartBootDeps["enqueueWakeMessage"]>;
  events: Array<{ event: string; details: Record<string, unknown> }>;
} {
  const appendSystemNotice = vi
    .fn<AppRestartBootDeps["appendSystemNotice"]>()
    .mockReturnValue(true);
  const enqueueWakeMessage = vi
    .fn<AppRestartBootDeps["enqueueWakeMessage"]>()
    .mockResolvedValue(undefined);
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  const deps: AppRestartBootDeps = {
    ledgerDir: dir,
    appendSystemNotice,
    enqueueWakeMessage,
    onLifecycleEvent: (event, details) => events.push({ event, details }),
    ...overrides,
  };
  return { deps, appendSystemNotice, enqueueWakeMessage, events };
}

describe("surfaceCompletedRestartsOnBoot", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-boot-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when the ledger has no pending restarts", async () => {
    const { deps, appendSystemNotice, enqueueWakeMessage } = makeDeps(dir);
    const result = await surfaceCompletedRestartsOnBoot(deps);
    expect(result).toEqual({ completed: 0, wakesEnqueued: 0 });
    expect(appendSystemNotice).not.toHaveBeenCalled();
    expect(enqueueWakeMessage).not.toHaveBeenCalled();
  });

  it("surfaces a completed restart: notice + wake message + lifecycle event", async () => {
    const pending = recordPendingRestartSync(dir, {
      requesterSessionId: "sess-1",
      reason: "reload runtime packs",
      force: false,
    });
    const { deps, appendSystemNotice, enqueueWakeMessage, events } = makeDeps(dir);
    const result = await surfaceCompletedRestartsOnBoot(deps);
    expect(result).toEqual({ completed: 1, wakesEnqueued: 1 });

    expect(appendSystemNotice).toHaveBeenCalledTimes(1);
    const [noticeSessionId, notice] = appendSystemNotice.mock.calls[0];
    expect(noticeSessionId).toBe("sess-1");
    expect(notice.id).toBe(`app-restart:${pending?.id}`);
    expect(notice.content).toContain("reload runtime packs");

    expect(enqueueWakeMessage).toHaveBeenCalledTimes(1);
    const wake = enqueueWakeMessage.mock.calls[0][0];
    expect(wake).toMatchObject({
      messageId: `app-restart-wake:${pending?.id}`,
      idempotencyKey: `app-restart-wake:${pending?.id}`,
      source: "app-restart",
      target: "sess-1",
      kind: "app-restart",
      deliveryMode: "queue",
    });
    expect(wake.content).toContain("reload runtime packs");

    expect(events).toEqual([
      expect.objectContaining({
        event: "app.restart.completed",
        details: expect.objectContaining({ requesterSessionId: "sess-1" }),
      }),
    ]);

    // Ledger now holds pending + completed; a second boot is a no-op.
    expect(readRestartLedgerEntries(dir)).toHaveLength(2);
    const second = await surfaceCompletedRestartsOnBoot(makeDeps(dir).deps);
    expect(second).toEqual({ completed: 0, wakesEnqueued: 0 });
  });

  it("still appends the notice when the wake enqueue rejects", async () => {
    recordPendingRestartSync(dir, {
      requesterSessionId: "sess-1",
      reason: "half-broken outbox",
      force: false,
    });
    const { deps, appendSystemNotice } = makeDeps(dir, {
      enqueueWakeMessage: vi
        .fn<AppRestartBootDeps["enqueueWakeMessage"]>()
        .mockRejectedValue(new Error("outbox down")),
    });
    const result = await surfaceCompletedRestartsOnBoot(deps);
    expect(result).toEqual({ completed: 1, wakesEnqueued: 0 });
    expect(appendSystemNotice).toHaveBeenCalledTimes(1);
  });

  it("still enqueues the wake when the notice append throws", async () => {
    recordPendingRestartSync(dir, {
      requesterSessionId: "sess-1",
      reason: "half-broken store",
      force: true,
    });
    const { deps, enqueueWakeMessage } = makeDeps(dir, {
      appendSystemNotice: vi
        .fn<AppRestartBootDeps["appendSystemNotice"]>()
        .mockImplementation(() => {
          throw new Error("store down");
        }),
    });
    const result = await surfaceCompletedRestartsOnBoot(deps);
    expect(result).toEqual({ completed: 1, wakesEnqueued: 1 });
    expect(enqueueWakeMessage).toHaveBeenCalledTimes(1);
  });
});
