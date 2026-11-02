// Marshal ownership: relocated module identity.
import { describe, it, expect } from "vitest";

import { isInsideAsar } from "./preload-path";

describe("isInsideAsar", () => {
  it("returns true for paths inside app.asar (forward slash)", () => {
    expect(isInsideAsar("/resources/app.asar/dist-electron/main.js")).toBe(true);
  });

  it("returns true for paths inside app.asar (backslash)", () => {
    expect(
      isInsideAsar("C:\\Program Files\\App\\resources\\app.asar\\dist-electron\\main.js"),
    ).toBe(true);
  });

  it("returns false for paths inside app.asar.unpacked (forward slash)", () => {
    expect(
      isInsideAsar("/resources/app.asar.unpacked/dist-electron/mini-mode-page/index.html"),
    ).toBe(false);
  });

  it("returns false for paths inside app.asar.unpacked (backslash)", () => {
    expect(
      isInsideAsar(
        "C:\\Program Files\\App\\resources\\app.asar.unpacked\\dist-electron\\preload.cjs",
      ),
    ).toBe(false);
  });

  it("returns false for dev-mode paths with no .asar segment", () => {
    expect(isInsideAsar("/Projects/m/dist-electron/preload.cjs")).toBe(false);
  });

  it("returns false for extraResources paths", () => {
    expect(isInsideAsar("C:\\Program Files\\App\\resources\\preload.cjs")).toBe(false);
  });

  it("rejects a crafted path with non-app .asar.unpacked nested inside app.asar", () => {
    // A path inside app.asar containing a nested "foo.asar.unpacked" segment.
    // The regex only allows "app.asar.unpacked" as the exception, not arbitrary
    // ".asar.unpacked" segments — so this correctly returns true (inside ASAR).
    expect(isInsideAsar("/resources/app.asar/dist-electron/foo.asar.unpacked/bar.js")).toBe(true);
  });

  it("returns true when app.asar is present but .asar.unpacked is not a segment", () => {
    // .asar.unpacked as a substring but not as the app.asar.unpacked segment
    expect(isInsideAsar("/resources/app.asar/something.asar.unpacked.txt")).toBe(true);
  });

  it("returns false for empty paths", () => {
    expect(isInsideAsar("")).toBe(false);
  });
});
