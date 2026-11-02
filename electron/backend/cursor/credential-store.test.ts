import path from "node:path";

import { describe, expect, it } from "vitest";

import { CURSOR_SDK_AUTH_RELATIVE_PATH } from "./constants";
import { marshalCursorCredentialStorePath } from "./credential-store";

describe("marshalCursorCredentialStorePath", () => {
  it("stores the minted key under Marshal app data", () => {
    expect(marshalCursorCredentialStorePath("/tmp/marshal-data")).toBe(
      path.join("/tmp/marshal-data", CURSOR_SDK_AUTH_RELATIVE_PATH),
    );
  });

  it("gives each extra account its own store and rejects unsafe ids", () => {
    expect(marshalCursorCredentialStorePath("/tmp/marshal-data", "work")).toBe(
      path.join("/tmp/marshal-data", "cursor-accounts", "work", CURSOR_SDK_AUTH_RELATIVE_PATH),
    );
    expect(() => marshalCursorCredentialStorePath("/tmp/marshal-data", "../escape")).toThrow(
      "Invalid Cursor account id",
    );
  });
});
