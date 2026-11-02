// Marshal-owned test
import { describe, it, expect, vi, beforeEach } from "vitest";

let nextId = 1;
const active = new Set<number>();

vi.mock("electron", () => ({
  powerSaveBlocker: {
    start: vi.fn<(type: string) => number>(() => {
      const id = nextId++;
      active.add(id);
      return id;
    }),
    stop: vi.fn<(id: number) => void>((id: number) => {
      active.delete(id);
    }),
    isStarted: vi.fn<(id: number) => boolean>((id: number) => active.has(id)),
  },
}));

import { powerSaveBlocker } from "electron";

import { PowerManager } from "./power";

describe("PowerManager", () => {
  let pm: PowerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    nextId = 1;
    active.clear();
    pm = new PowerManager();
  });

  it("starts blocker when first session becomes busy", () => {
    pm.markBusy("session-1");
    expect(powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");
    expect(pm.isBlocking()).toBe(true);
    expect(pm.busyCount()).toBe(1);
  });

  it("does not start a second blocker for additional busy sessions", () => {
    pm.markBusy("session-1");
    pm.markBusy("session-2");
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(pm.busyCount()).toBe(2);
  });

  it("stops blocker when all sessions become idle", () => {
    pm.markBusy("session-1");
    pm.markBusy("session-2");
    pm.markIdle("session-1");
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    expect(pm.isBlocking()).toBe(true);
    pm.markIdle("session-2");
    expect(powerSaveBlocker.stop).toHaveBeenCalled();
    expect(pm.busyCount()).toBe(0);
  });

  it("handles markIdle for unknown session gracefully", () => {
    pm.markIdle("nonexistent");
    expect(pm.busyCount()).toBe(0);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it("handles duplicate markBusy calls idempotently", () => {
    pm.markBusy("session-1");
    pm.markBusy("session-1");
    expect(pm.busyCount()).toBe(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
  });

  it("destroy stops the blocker and clears state", () => {
    pm.markBusy("session-1");
    pm.markBusy("session-2");
    pm.destroy();
    expect(powerSaveBlocker.stop).toHaveBeenCalled();
    expect(pm.busyCount()).toBe(0);
  });

  it("can restart after destroy", () => {
    pm.markBusy("session-1");
    pm.destroy();
    pm.markBusy("session-2");
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2);
    expect(pm.isBlocking()).toBe(true);
    expect(pm.busyCount()).toBe(1);
  });

  it("destroy is safe when no blocker is active", () => {
    pm.destroy();
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it("preventSleep starts system sleep blocker (not display)", () => {
    pm.preventSleep("heartbeat");
    expect(powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");
    expect(powerSaveBlocker.start).not.toHaveBeenCalledWith("prevent-display-sleep");
    expect(pm.isBlocking()).toBe(true);
  });

  it("preventSleep is idempotent for same reason", () => {
    pm.preventSleep("heartbeat");
    pm.preventSleep("heartbeat");
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
  });

  it("allowSleep stops display sleep blocker when last hold released", () => {
    pm.preventSleep("heartbeat");
    pm.allowSleep("heartbeat");
    expect(powerSaveBlocker.stop).toHaveBeenCalled();
    expect(pm.isBlocking()).toBe(false);
  });

  it("allowSleep is safe when not blocking", () => {
    pm.allowSleep("heartbeat");
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it("stays active when one hold remains after partial release", () => {
    pm.preventSleep("heartbeat");
    pm.preventSleep("relay");
    pm.allowSleep("heartbeat");
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    expect(pm.isBlocking()).toBe(true);
    pm.allowSleep("relay");
    expect(powerSaveBlocker.stop).toHaveBeenCalled();
    expect(pm.isBlocking()).toBe(false);
  });

  it("destroy stops both blockers", () => {
    pm.markBusy("session-1");
    pm.preventSleep("heartbeat");
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2);
    pm.destroy();
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(2);
    expect(pm.isBlocking()).toBe(false);
  });
});
