import { describe, expect, it } from "vitest";

import { MAX_DOCUMENT_ANNOTATIONS, normalizeDocumentExtras } from "./document-annotations";

const fail = (message: string) => new Error(message);

describe("normalizeDocumentExtras", () => {
  it("keeps valid annotations and drops absent optional fields", () => {
    expect(
      normalizeDocumentExtras(
        {
          revealLine: 12,
          annotations: [
            { startLine: 12, tone: "info", label: "owner: backend/claude" },
            { startLine: 20, endLine: 22, tone: "muted", label: "skip", detail: "logging" },
          ],
        },
        fail,
      ),
    ).toEqual({
      revealLine: 12,
      annotations: [
        { startLine: 12, tone: "info", label: "owner: backend/claude" },
        { startLine: 20, endLine: 22, tone: "muted", label: "skip", detail: "logging" },
      ],
    });
    expect(normalizeDocumentExtras({}, fail)).toEqual({});
  });

  it.each([
    [{ revealLine: 0 }, /revealLine/],
    [{ revealLine: 1.5 }, /revealLine/],
    [{ annotations: "x" }, /must be an array/],
    [{ annotations: [{ startLine: 1, tone: "loud", label: "x" }] }, /tone/],
    [{ annotations: [{ startLine: 5, endLine: 4, tone: "info", label: "x" }] }, /precede/],
    [{ annotations: [{ startLine: 1, tone: "info", label: "  " }] }, /label/],
    [{ annotations: [{ startLine: 1, tone: "info", label: "x", color: "red" }] }, /"color"/],
    [
      {
        annotations: Array.from({ length: MAX_DOCUMENT_ANNOTATIONS + 1 }, () => ({
          startLine: 1,
          tone: "info",
          label: "x",
        })),
      },
      /At most/,
    ],
  ])("rejects %j", (source, message) => {
    expect(() => normalizeDocumentExtras(source, fail)).toThrow(message);
  });
});
