import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalTelemetryEventPayload } from "../../common/local-telemetry";
import type { LocalTelemetryDeleteOutcome } from "../local-telemetry-store";
import { registerTelemetryHandlers } from "./telemetry-ipc";

describe("local telemetry IPC", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const append = vi.fn<() => Promise<void>>();
  const prune = vi.fn<() => Promise<void>>();
  const deleteAll = vi.fn<() => Promise<LocalTelemetryDeleteOutcome>>();
  const store = { append, prune, deleteAll };

  function register(enabled = true, onRendererFinalized?: () => void): void {
    handlers.clear();
    registerTelemetryHandlers(
      {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic IPC registration test double
        ipcHandle: ((channel: string, handler: (...args: unknown[]) => unknown) => {
          handlers.set(channel, handler);
        }) as never,
      },
      store,
      enabled,
      { onRendererFinalized },
    );
  }

  async function write(payload: LocalTelemetryEventPayload) {
    return handlers.get("telemetry:write-local-event")!(null, payload);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    append.mockResolvedValue();
    prune.mockResolvedValue();
    deleteAll.mockResolvedValue({
      complete: true,
      deletedFiles: 2,
      deletedBytes: 256,
      remainingFiles: 0,
      remainingBytes: 0,
      failedFiles: 0,
      failureCodes: [],
    });
    register();
  });

  it("filters renderer fields before writing", async () => {
    const result = await write({
      eventType: "Marshal.Fetch",
      fields: {
        scenario: "LlmTokenUsage",
        source: "HostApp",
        result: "success",
        duration: 25,
        userId: "user-1",
        tenantId: "tenant-1",
        requestCorrelationId: "remote-request",
        responseCorrelationId: "remote-provider",
        misc: JSON.stringify({
          model: "gpt-5",
          inputTokens: 12,
          prompt: "customer prompt",
        }),
      },
    });

    expect(result).toEqual({ success: true });
    expect(append).toHaveBeenCalledWith({
      eventType: "Marshal.Fetch",
      fields: {
        duration: 25,
        inputTokens: 12,
        model: "gpt-5",
        result: "success",
        scenario: "LlmTokenUsage",
        source: "HostApp",
      },
    });
  });

  it("preserves restart semantics when collection was disabled at launch", async () => {
    register(false);

    const result = await write({
      eventType: "Marshal.SessionStart",
      fields: { gesture: "hostApp" },
    });

    expect(result).toEqual({
      success: false,
      error: "Local telemetry collection is disabled until Marshal restarts.",
    });
    expect(append).not.toHaveBeenCalled();
  });

  it("rejects unsupported event types", async () => {
    const result = await write({
      eventType: "Marshal.ErrorDebug",
      fields: { debugMessage: "customer text" },
    });

    expect(result).toEqual({
      success: false,
      error: "Unsupported or invalid local telemetry event.",
    });
    expect(append).not.toHaveBeenCalled();
  });

  it("returns a clear error when persistence fails", async () => {
    append.mockRejectedValueOnce(new Error("disk failed"));

    const result = await write({
      eventType: "Marshal.SessionStart",
      fields: { gesture: "hostApp" },
    });

    expect(result).toEqual({
      success: false,
      error: "Failed to write local telemetry data.",
    });
  });

  it("deletes local telemetry through the serialized store", async () => {
    const result = await handlers.get("telemetry:delete-local-data")!(null);

    expect(result).toEqual({
      success: true,
      deletedFiles: 2,
      deletedBytes: 256,
      remainingFiles: 0,
      remainingBytes: 0,
      failedFiles: 0,
    });
    expect(deleteAll).toHaveBeenCalledOnce();
  });

  it("returns an explicit incomplete result when telemetry remains", async () => {
    deleteAll.mockResolvedValueOnce({
      complete: false,
      deletedFiles: 1,
      deletedBytes: 128,
      remainingFiles: 1,
      remainingBytes: 64,
      failedFiles: 1,
      failureCodes: ["EIO"],
    });

    const result = await handlers.get("telemetry:delete-local-data")!(null);

    expect(result).toEqual({
      success: false,
      deletedFiles: 1,
      deletedBytes: 128,
      remainingFiles: 1,
      remainingBytes: 64,
      failedFiles: 1,
      error:
        "Local telemetry deletion was incomplete: 64 bytes remain; 1 file could not be verified.",
    });
  });

  it("returns a clear deletion error", async () => {
    deleteAll.mockRejectedValueOnce(new Error("locked"));
    const result = await handlers.get("telemetry:delete-local-data")!(null);

    expect(result).toEqual({
      success: false,
      deletedFiles: 0,
      deletedBytes: 0,
      remainingFiles: 0,
      remainingBytes: 0,
      failedFiles: 1,
      error: "Failed to delete local telemetry data.",
    });
  });

  it("acknowledges renderer finalization", async () => {
    const onRendererFinalized = vi.fn<() => void>();
    register(true, onRendererFinalized);

    const result = await handlers.get("telemetry:renderer-finalized")!(null);

    expect(result).toEqual({ success: true });
    expect(onRendererFinalized).toHaveBeenCalledOnce();
  });
});
