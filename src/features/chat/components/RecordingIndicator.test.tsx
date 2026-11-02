import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecordingIndicator } from "./RecordingIndicator";

describe("RecordingIndicator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the waveform canvas and an initial 0:00 timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    render(<RecordingIndicator analyser={null} startedAt={Date.now()} />);

    expect(screen.getByTestId("recording-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("recording-timer").textContent).toBe("0:00");
  });

  it("advances the counting timer as recording continues", () => {
    vi.useFakeTimers();
    const start = new Date("2025-01-01T00:00:00Z").getTime();
    vi.setSystemTime(start);
    render(<RecordingIndicator analyser={null} startedAt={start} />);

    act(() => {
      vi.setSystemTime(start + 65_000);
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByTestId("recording-timer").textContent).toBe("1:05");
  });
});
