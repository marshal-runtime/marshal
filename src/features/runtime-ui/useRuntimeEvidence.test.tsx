import type { RuntimeUiAPI } from "@common/marshal-ipc-contract";
import { describe, expect, it, vi } from "vitest";

import { act, renderHook, waitFor } from "@/test-utils";

import { useRuntimeEvidence } from "./useRuntimeEvidence";

const entry = {
  sessionId: "session-1",
  workspaceName: "workspace",
  extensionId: "extension",
  applicationId: "runs",
  applicationTitle: "Swarm",
  id: "run-1",
  title: "Completed run",
  status: "completed",
};

describe("persistent runtime evidence", () => {
  it("loads completed runs independently of panel state and reopens the same identity after navigation", async () => {
    const getEvidence = vi
      .fn<NonNullable<RuntimeUiAPI["getEvidence"]>>()
      .mockResolvedValue({ success: true, value: [entry] });
    const openEvidence = vi.fn<NonNullable<RuntimeUiAPI["openEvidence"]>>().mockResolvedValue({
      success: true,
      value: {
        receipt: {
          receiptId: "list",
          action: "list",
          status: "applied",
          completedAt: "now",
          revision: 0,
        },
        instances: [],
      },
    });
    window.runtimeUiAPI = {
      getEvidence,
      openEvidence,
      onEvent: vi.fn<RuntimeUiAPI["onEvent"]>().mockReturnValue(() => {}),
      getSnapshot: vi.fn<RuntimeUiAPI["getSnapshot"]>(),
      subscribe: vi.fn<RuntimeUiAPI["subscribe"]>(),
      unsubscribe: vi.fn<RuntimeUiAPI["unsubscribe"]>(),
      open: vi.fn<RuntimeUiAPI["open"]>(),
      update: vi.fn<RuntimeUiAPI["update"]>(),
      focus: vi.fn<RuntimeUiAPI["focus"]>(),
      close: vi.fn<RuntimeUiAPI["close"]>(),
      list: vi.fn<RuntimeUiAPI["list"]>(),
      getPlacements: vi.fn<RuntimeUiAPI["getPlacements"]>(),
      activatePlacement: vi.fn<RuntimeUiAPI["activatePlacement"]>(),
    };
    const { result: firstResult, unmount } = renderHook(() =>
      useRuntimeEvidence("session-1", "workspace"),
    );
    await waitFor(() => expect(firstResult.current.entries).toEqual([entry]));
    unmount();
    const { result: reopenedResult } = renderHook(() =>
      useRuntimeEvidence("session-1", "workspace"),
    );
    await waitFor(() => expect(reopenedResult.current.entries).toEqual([entry]));
    await act(() => reopenedResult.current.open(entry));
    expect(openEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", sessionId: "session-1", applicationId: "runs" }),
    );
    expect(getEvidence).toHaveBeenCalledTimes(2);
  });
});
