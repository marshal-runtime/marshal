import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../settings-store", () => ({
  loadSettingsFromDisk: vi.fn<() => { runtimeId: string }>(() => ({ runtimeId: "copilot" })),
}));
vi.mock("../transcribe/transcribe", () => ({
  transcribeAudio: vi.fn<typeof import("../transcribe/transcribe").transcribeAudio>(),
}));

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { CURSOR_RUNTIME_ID } from "../../common/runtime-config";
import {
  registerTranscribeHandlers,
  TRANSCRIBE_UNAVAILABLE_MESSAGE,
  type TranscribeIpcDeps,
} from "./transcribe-ipc";

let registeredTranscribeHandler: IpcHandler<"transcribe:audio"> | undefined;
// Electron's invoke event is intentionally ignored by this handler.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal test double for Electron's platform-owned event
const invokeEvent = {} as unknown as Electron.IpcMainInvokeEvent;

beforeEach(() => {
  registeredTranscribeHandler = undefined;
});

function ipcHandle<C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) {
  if (channel !== "transcribe:audio") throw new Error(`Unexpected IPC channel: ${channel}`);
  // The runtime channel check establishes the correlated handler type, which TypeScript cannot
  // preserve through this generic callback boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- channel equality validates the test registration
  registeredTranscribeHandler = handler as unknown as IpcHandler<"transcribe:audio">;
}

describe("registerTranscribeHandlers", () => {
  it("rejects transcription when Cursor SDK speech-to-text is unavailable", async () => {
    const transcribe = vi.fn<NonNullable<TranscribeIpcDeps["transcribe"]>>();
    registerTranscribeHandlers({
      ipcHandle,
      loadRuntimeId: () => CURSOR_RUNTIME_ID,
      transcribe,
    });

    const handler = registeredTranscribeHandler;
    await expect(handler?.(invokeEvent, "AAAA", "audio/wav")).resolves.toEqual({
      success: false,
      error: TRANSCRIBE_UNAVAILABLE_MESSAGE,
      errorKind: "other",
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("rejects transcription for non-Cursor runtimes", async () => {
    const transcribe = vi.fn<NonNullable<TranscribeIpcDeps["transcribe"]>>();
    registerTranscribeHandlers({
      ipcHandle,
      loadRuntimeId: () => "copilot",
      transcribe,
    });

    const handler = registeredTranscribeHandler;
    await expect(handler?.(invokeEvent, "AAAA")).resolves.toMatchObject({
      success: false,
      error: TRANSCRIBE_UNAVAILABLE_MESSAGE,
    });
    expect(transcribe).not.toHaveBeenCalled();
  });
});
