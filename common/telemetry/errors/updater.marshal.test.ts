// Marshal-owned test
import { describe, expect, it } from "vitest";

import { mockTelemetryCallbacks } from "./marshal-test-helpers";
import { makeUpdaterError, registerUpdaterErrors, updaterErrors } from "./marshal-updater";

describe("updater error family", () => {
  it("makeUpdaterError returns correct family and code for every member", () => {
    expect(makeUpdaterError(updaterErrors.MANIFEST_TIMEOUT)).toEqual({
      family: "marshal-updater",
      code: 0,
    });
    expect(makeUpdaterError(updaterErrors.MANIFEST_NETWORK_ERROR)).toEqual({
      family: "marshal-updater",
      code: 1,
    });
    expect(makeUpdaterError(updaterErrors.MANIFEST_SERVER_ERROR)).toEqual({
      family: "marshal-updater",
      code: 2,
    });
    expect(makeUpdaterError(updaterErrors.MANIFEST_BAD_REQUEST)).toEqual({
      family: "marshal-updater",
      code: 3,
    });
    expect(makeUpdaterError(updaterErrors.MANIFEST_SCHEMA_INVALID)).toEqual({
      family: "marshal-updater",
      code: 4,
    });
    expect(makeUpdaterError(updaterErrors.ASSET_NAME_REJECTED)).toEqual({
      family: "marshal-updater",
      code: 5,
    });
    expect(makeUpdaterError(updaterErrors.DOWNLOAD_HOST_REJECTED)).toEqual({
      family: "marshal-updater",
      code: 6,
    });
    expect(makeUpdaterError(updaterErrors.DOWNLOAD_TIMEOUT)).toEqual({
      family: "marshal-updater",
      code: 7,
    });
    expect(makeUpdaterError(updaterErrors.DOWNLOAD_RESPONSE_FAILED)).toEqual({
      family: "marshal-updater",
      code: 8,
    });
    expect(makeUpdaterError(updaterErrors.DOWNLOAD_STREAM_FAILED)).toEqual({
      family: "marshal-updater",
      code: 9,
    });
    expect(makeUpdaterError(updaterErrors.DOWNLOAD_SHA256_MISMATCH)).toEqual({
      family: "marshal-updater",
      code: 10,
    });
    expect(makeUpdaterError(updaterErrors.SIGNATURE_VERIFY_FAILED)).toEqual({
      family: "marshal-updater",
      code: 11,
    });
    expect(makeUpdaterError(updaterErrors.INSTALL_FAILED)).toEqual({
      family: "marshal-updater",
      code: 12,
    });
    expect(makeUpdaterError(updaterErrors.GITHUB_BETA_REFRESH_FAILED)).toEqual({
      family: "marshal-updater",
      code: 13,
    });
  });

  it("registerUpdaterErrors calls callbacks.registerErrors with correct args", () => {
    const callbacks = mockTelemetryCallbacks();
    registerUpdaterErrors(callbacks);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-updater", updaterErrors);
  });
});
