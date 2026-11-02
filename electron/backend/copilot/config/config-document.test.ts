import { describe, expect, it } from "vitest";

import { parseCopilotConfigDocument } from "./config-document";

describe("parseCopilotConfigDocument", () => {
  it("parses plain JSON", () => {
    expect(parseCopilotConfigDocument('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("tolerates a leading // line comment (the Copilot CLI's own header)", () => {
    const input = `// User settings for the Copilot CLI.
// Edit at your own risk.
{"logged_in_users":[{"login":"alice"}],"last_logged_in_user":"alice"}`;
    expect(parseCopilotConfigDocument(input)).toEqual({
      logged_in_users: [{ login: "alice" }],
      last_logged_in_user: "alice",
    });
  });

  it("tolerates inline // line comments between fields", () => {
    const input = `{
      // active user
      "last_logged_in_user": "alice",
      "logged_in_users": [{"login": "alice"}] // primary
    }`;
    expect(parseCopilotConfigDocument(input)).toEqual({
      last_logged_in_user: "alice",
      logged_in_users: [{ login: "alice" }],
    });
  });

  it("tolerates /* block */ comments", () => {
    const input = `/* header
       multi-line */ {"k": 1}`;
    expect(parseCopilotConfigDocument(input)).toEqual({ k: 1 });
  });

  it("does NOT strip // or /* inside string values", () => {
    const input = `{"url": "https://example.com/foo", "note": "use /* like this */"}`;
    expect(parseCopilotConfigDocument(input)).toEqual({
      url: "https://example.com/foo",
      note: "use /* like this */",
    });
  });

  it("handles escaped quotes inside strings", () => {
    const input = `{"a": "she said \\"hi // there\\""}`;
    expect(parseCopilotConfigDocument(input)).toEqual({ a: 'she said "hi // there"' });
  });

  it("preserves native JSON.parse rejection of trailing commas", () => {
    const input = '{"items": [1, 2,],}';
    expect(captureParseError(() => parseCopilotConfigDocument(input))).toEqual(
      captureParseError(() => JSON.parse(input)),
    );
  });

  it("throws on invalid JSON", () => {
    expect(() => parseCopilotConfigDocument(`{"a": ,}`)).toThrow(/JSON/);
  });
});

function captureParseError(parse: () => unknown): { name: string; message: string } {
  try {
    parse();
  } catch (error) {
    if (error instanceof Error) {
      return { name: error.name, message: error.message };
    }
    throw error;
  }
  throw new Error("Expected parsing to fail");
}
