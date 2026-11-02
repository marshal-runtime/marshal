import { TRANSCRIBE_NOT_CONFIGURED_MESSAGE } from "@common/transcribe-errors";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TranscribeError } from "@/services/transcribe";
import { createMockShellAPI } from "@/test-utils";

import { useAudioRecorder } from "../hooks/useAudioRecorder";
import { MicButton } from "./MicButton";

interface ToastOptions {
  duration?: number;
  action?: { label: string; onClick: () => void };
}

const toastError = vi.fn<(message: string, opts?: ToastOptions) => void>();
const toastPlain = vi.fn<(message: string) => void>();
vi.mock("sonner", () => ({
  toast: Object.assign((message: string) => toastPlain(message), {
    error: (message: string, opts?: ToastOptions) => toastError(message, opts),
  }),
}));

vi.mock("../hooks/useAudioRecorder", () => ({
  useAudioRecorder: vi.fn<typeof useAudioRecorder>(),
}));

const mockedUseAudioRecorder = vi.mocked(useAudioRecorder);
const openExternal = vi
  .fn<(url: string) => Promise<{ success: boolean }>>()
  .mockResolvedValue({ success: true });

/** Configure the recorder hook so a click triggers stopAndTranscribe. */
function recordingThatRejectsWith(error: unknown) {
  mockedUseAudioRecorder.mockReturnValue({
    status: "recording",
    error: null,
    busy: true,
    startedAt: Date.now(),
    analyser: null,
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stopAndTranscribe: vi.fn<() => Promise<string>>().mockRejectedValue(error),
    cancel: vi.fn<() => void>(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.shellAPI = createMockShellAPI({ openExternal });
});

afterEach(() => {
  delete (window as { shellAPI?: unknown }).shellAPI;
});

describe("MicButton transcription error prompts", () => {
  it("shows the setup prompt for not-configured without an external action", async () => {
    const user = userEvent.setup();
    recordingThatRejectsWith(new TranscribeError("missing key", "not-configured"));
    render(<MicButton onTranscript={vi.fn<(text: string) => void>()} />);

    await user.click(screen.getByTestId("mic-btn"));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const [message, opts] = toastError.mock.calls[0];
    expect(message).toBe(TRANSCRIBE_NOT_CONFIGURED_MESSAGE);
    expect(opts?.duration).toBe(12_000);
    expect(opts?.action).toBeUndefined();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("falls back to a plain error toast for generic failures", async () => {
    const user = userEvent.setup();
    recordingThatRejectsWith(new TranscribeError("Transcription failed (HTTP 500)", "other"));
    render(<MicButton onTranscript={vi.fn<(text: string) => void>()} />);

    await user.click(screen.getByTestId("mic-btn"));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const [message, opts] = toastError.mock.calls[0];
    expect(message).toBe("Transcription failed (HTTP 500)");
    expect(opts).toBeUndefined();
  });
});

describe("MicButton recording indicator", () => {
  function mockRecorder(overrides: Partial<ReturnType<typeof useAudioRecorder>>) {
    mockedUseAudioRecorder.mockReturnValue({
      status: "idle",
      error: null,
      busy: false,
      startedAt: null,
      analyser: null,
      start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      stopAndTranscribe: vi.fn<() => Promise<string>>().mockResolvedValue(""),
      cancel: vi.fn<() => void>(),
      ...overrides,
    });
  }

  it("shows the waveform and counting timer while recording", () => {
    mockRecorder({ status: "recording", busy: true, startedAt: Date.now() });
    render(<MicButton onTranscript={vi.fn<(text: string) => void>()} />);

    expect(screen.getByTestId("recording-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("recording-timer")).toBeInTheDocument();
  });

  it("hides the recording indicator when idle", () => {
    mockRecorder({ status: "idle" });
    render(<MicButton onTranscript={vi.fn<(text: string) => void>()} />);

    expect(screen.queryByTestId("recording-indicator")).not.toBeInTheDocument();
  });

  it("hides the recording indicator while transcribing", () => {
    mockRecorder({ status: "transcribing", busy: true });
    render(<MicButton onTranscript={vi.fn<(text: string) => void>()} />);

    expect(screen.queryByTestId("recording-indicator")).not.toBeInTheDocument();
  });
});
