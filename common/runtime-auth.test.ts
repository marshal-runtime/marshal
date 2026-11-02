import { describe, expect, it } from "vitest";

import { isRuntimeAuthLoginRequest } from "./runtime-auth";

describe("runtime auth request validation", () => {
  it("accepts supported typed login requests", () => {
    expect(isRuntimeAuthLoginRequest({ type: "browser" })).toBe(true);
    expect(isRuntimeAuthLoginRequest({ type: "device-code" })).toBe(true);
    expect(isRuntimeAuthLoginRequest({ type: "api-key", apiKey: "secret" })).toBe(true);
    expect(
      isRuntimeAuthLoginRequest({
        type: "amazon-bedrock",
        apiKey: "secret",
        region: "us-east-1",
      }),
    ).toBe(true);
  });

  it("rejects empty secrets and unknown shapes", () => {
    expect(isRuntimeAuthLoginRequest({ type: "api-key", apiKey: " " })).toBe(false);
    expect(isRuntimeAuthLoginRequest({ type: "amazon-bedrock", apiKey: "secret" })).toBe(false);
    expect(isRuntimeAuthLoginRequest({ type: "oauth" })).toBe(false);
  });
});
