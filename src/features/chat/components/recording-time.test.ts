import { describe, expect, it } from "vitest";

import { formatRecordingElapsed } from "./recording-time";

describe("formatRecordingElapsed", () => {
  it("formats sub-minute durations as m:ss", () => {
    expect(formatRecordingElapsed(0)).toBe("0:00");
    expect(formatRecordingElapsed(5_000)).toBe("0:05");
    expect(formatRecordingElapsed(59_400)).toBe("0:59");
  });

  it("rolls over into minutes", () => {
    expect(formatRecordingElapsed(60_000)).toBe("1:00");
    expect(formatRecordingElapsed(65_000)).toBe("1:05");
    expect(formatRecordingElapsed(600_000)).toBe("10:00");
  });

  it("switches to h:mm:ss past an hour", () => {
    expect(formatRecordingElapsed(3_600_000)).toBe("1:00:00");
    expect(formatRecordingElapsed(3_725_000)).toBe("1:02:05");
  });

  it("clamps negative input to zero", () => {
    expect(formatRecordingElapsed(-1_000)).toBe("0:00");
  });
});
