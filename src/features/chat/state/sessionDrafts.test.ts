import { afterEach, describe, expect, it } from "vitest";

import {
  _clearSessionDrafts,
  clearDraft,
  consumeSuppressNextPreviousSave,
  getDraft,
  MAX_DRAFTS,
  migrateDraft,
  saveDraft,
} from "./sessionDrafts";

afterEach(() => {
  _clearSessionDrafts();
});

describe("sessionDrafts", () => {
  it("returns undefined for a draft that was never saved", () => {
    expect(getDraft("missing-session")).toBeUndefined();
  });

  it("deletes the draft when saving empty text", () => {
    saveDraft("session-1", "draft");
    saveDraft("session-1", "");
    expect(getDraft("session-1")).toBeUndefined();
  });

  it("clears one targeted draft without clearing others", () => {
    saveDraft("session-1", "draft-1");
    saveDraft("session-2", "draft-2");

    clearDraft("session-1");

    expect(getDraft("session-1")).toBeUndefined();
    expect(getDraft("session-2")).toBe("draft-2");
  });

  it("evicts the oldest draft when the cap is exceeded", () => {
    for (let i = 0; i < MAX_DRAFTS + 1; i++) {
      saveDraft(`session-${i}`, `draft-${i}`);
    }

    expect(getDraft("session-0")).toBeUndefined();
    expect(getDraft("session-1")).toBe("draft-1");
    expect(getDraft(`session-${MAX_DRAFTS}`)).toBe(`draft-${MAX_DRAFTS}`);
  });

  it("re-saving an existing draft refreshes its recency (LRU, not FIFO)", () => {
    // Fill the map, then re-save the oldest before adding one more.
    for (let i = 0; i < MAX_DRAFTS; i++) saveDraft(`session-${i}`, `draft-${i}`);
    saveDraft("session-0", "draft-0-updated"); // touch oldest -> moves to end
    saveDraft(`session-${MAX_DRAFTS}`, `draft-${MAX_DRAFTS}`); // triggers eviction

    // Under LRU, session-0 survives because it was just touched;
    // session-1 (now the oldest by recency) is evicted instead.
    expect(getDraft("session-0")).toBe("draft-0-updated");
    expect(getDraft("session-1")).toBeUndefined();
    expect(getDraft(`session-${MAX_DRAFTS}`)).toBe(`draft-${MAX_DRAFTS}`);
  });
});

describe("migrateDraft + suppress flag", () => {
  it("seeds the new id with the text and clears the old id", () => {
    saveDraft("session-a", "old text");
    migrateDraft("session-a", "session-b", "new text");

    expect(getDraft("session-a")).toBeUndefined();
    expect(getDraft("session-b")).toBe("new text");
  });

  it("seeds the new id even when there was no fromId (initial session)", () => {
    migrateDraft(null, "session-b", "fresh text");

    expect(getDraft("session-b")).toBe("fresh text");
  });

  it("copies the draft when the source chat must remain unchanged", () => {
    saveDraft("session-a", "original text");

    migrateDraft("session-a", "session-b", "original text", { preserveSource: true });

    expect(getDraft("session-a")).toBe("original text");
    expect(getDraft("session-b")).toBe("original text");
    expect(consumeSuppressNextPreviousSave()).toBe(false);
  });

  it("arms the suppress flag exactly once per migrate (single migrate)", () => {
    migrateDraft("session-a", "session-b", "text");

    expect(consumeSuppressNextPreviousSave()).toBe(true);
    // Already consumed — second read returns false.
    expect(consumeSuppressNextPreviousSave()).toBe(false);
  });

  it("re-arms the suppress flag on each subsequent migrate (regression: multi-switch)", () => {
    // Without re-arming, the SECOND soul switch would let useDraftSync's
    // savePreviousDraft pass resurrect the orphan that migrateDraft just cleared,
    // and the editor would visibly drop the draft on switch #2 even though
    // switch #1 worked correctly.
    migrateDraft("session-a", "session-b", "text-1");
    expect(consumeSuppressNextPreviousSave()).toBe(true);

    migrateDraft("session-b", "session-c", "text-2");
    expect(consumeSuppressNextPreviousSave()).toBe(true);

    expect(getDraft("session-a")).toBeUndefined();
    expect(getDraft("session-b")).toBeUndefined();
    expect(getDraft("session-c")).toBe("text-2");
  });
});
