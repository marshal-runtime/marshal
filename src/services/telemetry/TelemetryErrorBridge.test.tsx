import { render } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authErrors, makeAuthError } from "../../../common/telemetry/errors/marshal-auth";
import { crashErrors, makeCrashError } from "../../../common/telemetry/errors/marshal-crash";
import { useGetLogErrorTelemetry } from "./opensource";

// Must be hoisted before module import so vi.mock resolves correctly
const mockLogError = vi.fn<() => void>();
vi.mock("./opensource", () => ({
  useGetLogErrorTelemetry: vi.fn<() => () => void>(() => mockLogError),
}));

import { routeError, setInSessionErrorLogger } from "./error-routing";
import { TelemetryErrorBridge } from "./TelemetryErrorBridge";

beforeEach(() => {
  mockLogError.mockReset();
  // Reset the hook to its default behavior (returning the shared mockLogError);
  // tests that need per-render fresh identities override this in-place.
  vi.mocked(useGetLogErrorTelemetry).mockImplementation(() => mockLogError);
});

afterEach(() => {
  // Clear any in-session logger the bridge left registered so it does not leak
  // across tests (mounts that aren't explicitly unmounted by RTL cleanup).
  setInSessionErrorLogger(null);
});

describe("TelemetryErrorBridge", () => {
  it("registers the in-session logger on mount so routeError reaches logError", () => {
    render(<TelemetryErrorBridge />);
    const error = makeAuthError(authErrors.AUTH_SILENT_ACQUIRE_FAILED);
    routeError(error);
    expect(mockLogError).toHaveBeenCalledWith(error);
  });

  it("unregisters the in-session logger on unmount", () => {
    const { unmount } = render(<TelemetryErrorBridge />);
    unmount();
    routeError(makeCrashError(crashErrors.REACT_ERROR_BOUNDARY));
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("survives React.StrictMode double-mount with a single live registrant", () => {
    // useEffectEvent: the register-once effect (empty deps) runs exactly once
    // per mount. StrictMode's mount → unmount → mount cycle clears the
    // registrant before the second mount re-registers — no stale logger.
    render(
      <StrictMode>
        <TelemetryErrorBridge />
      </StrictMode>,
    );

    // The bridge must be wired after the second mount — routeError delivers,
    // proving the in-session logger was never left null between mounts.
    const error = makeCrashError(crashErrors.REACT_ERROR_BOUNDARY);
    routeError(error);
    expect(mockLogError).toHaveBeenCalledWith(error);
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  it("routes to the latest logError when useGetLogErrorTelemetry returns a new function each render", () => {
    // useEffectEvent reads the latest logError per call without re-registering.
    // If useGetLogErrorTelemetry returns a fresh identity per render, the
    // registrant stays put and routeError routes to the latest.
    const freshFns: Array<ReturnType<typeof vi.fn>> = [];
    vi.mocked(useGetLogErrorTelemetry).mockImplementation(() => {
      // eslint-disable-next-line vitest/require-mock-type-parameters
      const fn = vi.fn();
      freshFns.push(fn);
      return fn;
    });

    function Harness() {
      const [, setN] = useState(0);
      useEffect(() => {
        setN(1);
        setN(2);
        setN(3);
      }, []);
      return <TelemetryErrorBridge />;
    }
    render(<Harness />);

    // The latest logError (from the most recent render) must be the one
    // invoked via useEffectEvent.
    const error = makeCrashError(crashErrors.REACT_ERROR_BOUNDARY);
    routeError(error);
    const latest = freshFns[freshFns.length - 1];
    expect(latest).toHaveBeenCalledWith(error);
  });
});
