// Marshal-owned test
import { describe, it, expect, vi } from "vitest";

import { ConditionSupervisor, parseCronIdFromParentSessionKey } from "./condition-supervisor";

describe("ConditionSupervisor", () => {
  it("calls cron.remove when handleSpawnFromCron is called for a known watcher", async () => {
    const cronRemove = vi
      .fn<(params: { id: string }) => Promise<unknown>>()
      .mockResolvedValue({ ok: true });
    const supervisor = new ConditionSupervisor({ cronRemove });
    supervisor.registerWatcher({ cronId: "cron-1" });

    await supervisor.handleSpawnFromCron("cron-1");

    expect(cronRemove).toHaveBeenCalledTimes(1);
    expect(cronRemove).toHaveBeenCalledWith({ id: "cron-1" });
  });

  it("does not call cron.remove for unknown cronIds", async () => {
    const cronRemove = vi
      .fn<(params: { id: string }) => Promise<unknown>>()
      .mockResolvedValue({ ok: true });
    const supervisor = new ConditionSupervisor({ cronRemove });

    await supervisor.handleSpawnFromCron("unknown-cron");

    expect(cronRemove).not.toHaveBeenCalled();
  });

  it("does not call cron.remove twice for the same watcher on duplicate spawn events", async () => {
    const cronRemove = vi
      .fn<(params: { id: string }) => Promise<unknown>>()
      .mockResolvedValue({ ok: true });
    const supervisor = new ConditionSupervisor({ cronRemove });
    supervisor.registerWatcher({ cronId: "cron-2" });

    await supervisor.handleSpawnFromCron("cron-2");
    await supervisor.handleSpawnFromCron("cron-2");

    expect(cronRemove).toHaveBeenCalledTimes(1);
  });

  it("swallows cron.remove failures without throwing", async () => {
    const cronRemove = vi
      .fn<(params: { id: string }) => Promise<unknown>>()
      .mockRejectedValue(new Error("simulated failure"));
    const supervisor = new ConditionSupervisor({ cronRemove });
    supervisor.registerWatcher({ cronId: "cron-3" });

    await expect(supervisor.handleSpawnFromCron("cron-3")).resolves.not.toThrow();
  });

  it("unregisters a watcher (subsequent spawns for that cronId do not trigger remove)", async () => {
    const cronRemove = vi
      .fn<(params: { id: string }) => Promise<unknown>>()
      .mockResolvedValue({ ok: true });
    const supervisor = new ConditionSupervisor({ cronRemove });
    supervisor.registerWatcher({ cronId: "cron-4" });
    supervisor.unregisterWatcher("cron-4");

    await supervisor.handleSpawnFromCron("cron-4");

    expect(cronRemove).not.toHaveBeenCalled();
  });

  it("registerWatcher is idempotent (no double cron.remove on subsequent spawn)", async () => {
    const cronRemove = vi
      .fn<(params: { id: string }) => Promise<unknown>>()
      .mockResolvedValue({ ok: true });
    const supervisor = new ConditionSupervisor({ cronRemove });
    supervisor.registerWatcher({ cronId: "cron-x" });
    supervisor.registerWatcher({ cronId: "cron-x" }); // double-register
    await supervisor.handleSpawnFromCron("cron-x");
    expect(cronRemove).toHaveBeenCalledTimes(1);
  });

  it("concurrent handleSpawnFromCron calls for the same cron only fire cron.remove once", async () => {
    // Pin the alreadyRemoved.add(cronId) ordering — that line MUST run before
    // the await on cron.remove. Otherwise two concurrent spawn observations
    // both pass the guard and double-fire cron.remove.
    let resolveRemove!: () => void;
    const cronRemove = vi.fn<(params: { id: string }) => Promise<unknown>>(
      () =>
        new Promise<unknown>((resolve) => {
          resolveRemove = () => resolve({ ok: true });
        }),
    );
    const supervisor = new ConditionSupervisor({ cronRemove });
    supervisor.registerWatcher({ cronId: "cron-x" });
    const both = Promise.all([
      supervisor.handleSpawnFromCron("cron-x"),
      supervisor.handleSpawnFromCron("cron-x"),
    ]);
    resolveRemove();
    await both;
    expect(cronRemove).toHaveBeenCalledTimes(1);
  });
});

describe("parseCronIdFromParentSessionKey", () => {
  it("extracts cronId from a cron-run session key", () => {
    expect(parseCronIdFromParentSessionKey("agent:my-agent:cron:cron-watcher-1:run:abc-123")).toBe(
      "cron-watcher-1",
    );
  });

  it("returns null for keys not matching the cron-run pattern", () => {
    expect(parseCronIdFromParentSessionKey("agent:my-agent:user-chat-1")).toBeNull();
    expect(parseCronIdFromParentSessionKey("agent:my-agent:cron:cron-watcher-1")).toBeNull(); // parent without :run:
    expect(parseCronIdFromParentSessionKey(undefined)).toBeNull();
    expect(parseCronIdFromParentSessionKey("")).toBeNull();
  });
});
