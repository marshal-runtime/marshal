import { describe, expect, it } from "vitest";

import { isTrustedTypeScriptEnabled, TRUSTED_TYPESCRIPT_ENV } from "./trusted-typescript";

describe("isTrustedTypeScriptEnabled", () => {
  it("defaults on for unpackaged builds and off for packaged builds", () => {
    expect(isTrustedTypeScriptEnabled({ isPackaged: false, env: {} })).toBe(true);
    expect(isTrustedTypeScriptEnabled({ isPackaged: true, env: {} })).toBe(false);
  });

  it("lets the environment override the build default in both directions", () => {
    expect(
      isTrustedTypeScriptEnabled({ isPackaged: true, env: { [TRUSTED_TYPESCRIPT_ENV]: "1" } }),
    ).toBe(true);
    expect(
      isTrustedTypeScriptEnabled({
        isPackaged: false,
        env: { [TRUSTED_TYPESCRIPT_ENV]: " False " },
      }),
    ).toBe(false);
  });

  it("ignores unrecognized values", () => {
    expect(
      isTrustedTypeScriptEnabled({ isPackaged: true, env: { [TRUSTED_TYPESCRIPT_ENV]: "yes" } }),
    ).toBe(false);
  });
});
