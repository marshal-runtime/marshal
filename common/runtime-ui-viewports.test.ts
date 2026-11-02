import { describe, expect, it } from "vitest";

import {
  DESKTOP_ONLY_VIEWPORTS,
  MARSHAL_UI_VIEWPORTS_METADATA_KEY,
  declaredUiViewportsFromMetadata,
  parseUiViewports,
} from "./runtime-ui-viewports";

describe("parseUiViewports", () => {
  it("accepts array and string declarations, case-insensitively", () => {
    expect(parseUiViewports(["mobile", "desktop"])).toEqual(new Set(["mobile", "desktop"]));
    expect(parseUiViewports(["MOBILE"])).toEqual(new Set(["mobile"]));
    expect(parseUiViewports("mobile desktop")).toEqual(new Set(["mobile", "desktop"]));
    expect(parseUiViewports("mobile, desktop")).toEqual(new Set(["mobile", "desktop"]));
    expect(parseUiViewports("desktop")).toEqual(new Set(["desktop"]));
  });

  it("treats absent or unrecognizable values as undeclared", () => {
    expect(parseUiViewports(undefined)).toBeNull();
    expect(parseUiViewports(null)).toBeNull();
    expect(parseUiViewports(42)).toBeNull();
    expect(parseUiViewports({ mobile: true })).toBeNull();
  });

  it("never widens by accident: a declaration with no recognized token is desktop-only", () => {
    expect(parseUiViewports("televisions")).toEqual(DESKTOP_ONLY_VIEWPORTS);
    expect(parseUiViewports([])).toEqual(DESKTOP_ONLY_VIEWPORTS);
    expect(parseUiViewports(["tablet", "watch"])).toEqual(DESKTOP_ONLY_VIEWPORTS);
  });
});

describe("declaredUiViewportsFromMetadata", () => {
  it("reads the documented publication metadata key", () => {
    expect(
      declaredUiViewportsFromMetadata({
        [MARSHAL_UI_VIEWPORTS_METADATA_KEY]: ["mobile", "desktop"],
      }),
    ).toEqual(new Set(["mobile", "desktop"]));
    expect(
      declaredUiViewportsFromMetadata({ [MARSHAL_UI_VIEWPORTS_METADATA_KEY]: "mobile" }),
    ).toEqual(new Set(["mobile"]));
  });

  it("returns undeclared for records without the key", () => {
    expect(declaredUiViewportsFromMetadata(undefined)).toBeNull();
    expect(declaredUiViewportsFromMetadata({})).toBeNull();
    expect(declaredUiViewportsFromMetadata({ other: true })).toBeNull();
  });
});
