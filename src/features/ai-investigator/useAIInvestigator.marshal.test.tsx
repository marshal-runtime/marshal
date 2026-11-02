// marshal-owned renderer test
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, renderHook } from "@/test-utils";
import type { AIInvestigatorEvent, AIInvestigatorAPI } from "@/types/electron";

import { useAIInvestigator } from "./useAIInvestigator";

interface Fixture {
  emit: (event: AIInvestigatorEvent) => void;
  api: AIInvestigatorAPI;
}

function setupAPI(overrides: Partial<AIInvestigatorAPI> = {}): Fixture {
  let listener: ((e: AIInvestigatorEvent) => void) | null = null;
  const onEvent = vi.fn<AIInvestigatorAPI["onEvent"]>((cb) => {
    listener = cb;
    return () => {
      listener = null;
    };
  });
  installMockAPIs({
    aiInvestigatorAPI: {
      onEvent,
      ...overrides,
    },
  });
  return {
    api: window.aiInvestigatorAPI!,
    emit: (e) => listener?.(e),
  };
}

describe("useAIInvestigator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts in idle state with empty log", async () => {
    setupAPI();
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(result.current.log).toEqual([]);
  });

  it("calls checkAvailability on mount and exposes available: true", async () => {
    const fx = setupAPI();
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(fx.api.checkAvailability).toHaveBeenCalledOnce();
  });

  it("exposes available: false when checkAvailability returns available: false", async () => {
    setupAPI({
      checkAvailability: vi
        .fn<AIInvestigatorAPI["checkAvailability"]>()
        .mockResolvedValue({ success: true, available: false }),
    });
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.available).toBe(false));
  });

  it("hydrates from getStatus on mount", async () => {
    setupAPI({
      getStatus: vi.fn<AIInvestigatorAPI["getStatus"]>().mockResolvedValue({
        success: true,
        status: {
          state: "ready",
          userDescription: "x",
          log: [{ timestamp: "t", message: "m" }],
          title: "Title",
          body: "Body",
        },
      }),
    });
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.title).toBe("Title");
    expect(result.current.body).toBe("Body");
    expect(result.current.log).toHaveLength(1);
  });

  it("appends progress events to the log", async () => {
    const fx = setupAPI();
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));
    act(() => fx.emit({ type: "progress", message: "checking" }));
    expect(result.current.log).toHaveLength(1);
    expect(result.current.log[0].message).toBe("checking");
  });

  it("transitions to ready when a `ready` event arrives", async () => {
    const fx = setupAPI();
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));
    act(() => fx.emit({ type: "ready", title: "T", body: "B" }));
    expect(result.current.state).toBe("ready");
    expect(result.current.title).toBe("T");
    expect(result.current.body).toBe("B");
  });

  it("transitions to posted with issue URL", async () => {
    const fx = setupAPI();
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));
    act(() => fx.emit({ type: "posted", issueUrl: "https://x/1" }));
    expect(result.current.state).toBe("posted");
    expect(result.current.issueUrl).toBe("https://x/1");
  });

  it("captures error events", async () => {
    const fx = setupAPI();
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));
    act(() => fx.emit({ type: "error", error: "boom" }));
    expect(result.current.state).toBe("error");
    expect(result.current.error).toBe("boom");
  });

  it("calls api.start with the user description", async () => {
    const fx = setupAPI();
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));
    await act(async () => {
      await result.current.start({ userDescription: "broken" });
    });
    expect(fx.api.start).toHaveBeenCalledWith({
      userDescription: "broken",
    });
  });

  it("isStartPending toggles true then false across start()", async () => {
    let resolve!: () => void;
    setupAPI({
      start: vi.fn<AIInvestigatorAPI["start"]>().mockReturnValue(
        new Promise<{ success: boolean }>((res) => {
          resolve = () => res({ success: true });
        }),
      ),
    });
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));

    // Start without awaiting so we can observe isPending=true
    act(() => {
      result.current.start({ userDescription: "x" }).catch(() => {});
    });
    await waitFor(() => expect(result.current.isStartPending).toBe(true));

    await act(async () => resolve());
    await waitFor(() => expect(result.current.isStartPending).toBe(false));
  });

  it("start() rejects → snapshot transitions to error, isStartPending clears", async () => {
    setupAPI({
      start: vi.fn<AIInvestigatorAPI["start"]>().mockRejectedValue(new Error("ipc exploded")),
    });
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));
    await act(async () => {
      await result.current.start({ userDescription: "x" });
    });
    await waitFor(() => {
      expect(result.current.isStartPending).toBe(false);
      expect(result.current.state).toBe("error");
      expect(result.current.error).toContain("ipc exploded");
    });
  });

  it("start() returns failure → snapshot transitions to error", async () => {
    setupAPI({
      start: vi
        .fn<AIInvestigatorAPI["start"]>()
        .mockResolvedValue({ success: false, error: "nope" }),
    });
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));
    await act(async () => {
      await result.current.start({ userDescription: "x" });
    });
    await waitFor(() => {
      expect(result.current.state).toBe("error");
      expect(result.current.error).toBe("nope");
    });
  });

  it("post() rejects → snapshot transitions to error, isPostPending clears (ST-I1)", async () => {
    setupAPI({
      post: vi.fn<AIInvestigatorAPI["post"]>().mockRejectedValue(new Error("post exploded")),
    });
    const fx = setupAPI({
      post: vi.fn<AIInvestigatorAPI["post"]>().mockRejectedValue(new Error("post exploded")),
    });
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));
    act(() => fx.emit({ type: "ready", title: "T", body: "B" }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      await result.current.post();
    });
    await waitFor(() => {
      expect(result.current.isPostPending).toBe(false);
      expect(result.current.state).toBe("error");
      expect(result.current.error).toContain("post exploded");
    });
  });

  it("cancel() rejects → snapshot transitions to error", async () => {
    setupAPI({
      cancel: vi.fn<AIInvestigatorAPI["cancel"]>().mockRejectedValue(new Error("cancel exploded")),
    });
    const fx = setupAPI({
      cancel: vi.fn<AIInvestigatorAPI["cancel"]>().mockRejectedValue(new Error("cancel exploded")),
    });
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));
    act(() => fx.emit({ type: "status", state: "investigating" }));
    await waitFor(() => expect(result.current.state).toBe("investigating"));

    await act(async () => {
      await result.current.cancel();
    });
    await waitFor(() => {
      expect(result.current.state).toBe("error");
    });
  });

  it("reset() returns the hook to idle and clears fields", async () => {
    const fx = setupAPI();
    const { result } = renderHook(() => useAIInvestigator());
    await waitFor(() => expect(result.current.state).toBe("idle"));
    act(() => fx.emit({ type: "ready", title: "T", body: "B" }));
    expect(result.current.state).toBe("ready");
    act(() => result.current.reset());
    await waitFor(() => {
      expect(result.current.state).toBe("idle");
      expect(result.current.title).toBeNull();
      expect(result.current.body).toBeNull();
    });
  });
});
