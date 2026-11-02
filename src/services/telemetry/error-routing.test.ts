import type { MidgardError } from "@common/telemetry/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  logErrorForCrash,
  routeError,
  setInSessionErrorLogger,
  setOutOfSessionErrorLogger,
} from "./error-routing";

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: routeError only reads messageId
const err = { messageId: "x" } as unknown as MidgardError;

afterEach(() => {
  setInSessionErrorLogger(null);
  setOutOfSessionErrorLogger(null);
});

describe("routeError", () => {
  it("no-ops when no logger is registered", () => {
    expect(() => routeError(err)).not.toThrow();
  });

  it("uses the out-of-session logger when only it is registered", () => {
    const out = vi.fn<(error: MidgardError) => void>();
    setOutOfSessionErrorLogger(out);
    routeError(err);
    expect(out).toHaveBeenCalledWith(err);
  });

  it("prefers the in-session logger when both are registered", () => {
    const out = vi.fn<(error: MidgardError) => void>();
    const inSession = vi.fn<(error: MidgardError) => void>();
    setOutOfSessionErrorLogger(out);
    setInSessionErrorLogger(inSession);
    routeError(err);
    expect(inSession).toHaveBeenCalledWith(err);
    expect(out).not.toHaveBeenCalled();
  });

  it("falls back to out-of-session after the in-session logger is cleared", () => {
    const out = vi.fn<(error: MidgardError) => void>();
    setOutOfSessionErrorLogger(out);
    setInSessionErrorLogger(vi.fn<(error: MidgardError) => void>());
    setInSessionErrorLogger(null);
    routeError(err);
    expect(out).toHaveBeenCalledWith(err);
  });

  it("logErrorForCrash routes through routeError", () => {
    const inSession = vi.fn<(error: MidgardError) => void>();
    setInSessionErrorLogger(inSession);
    logErrorForCrash(err);
    expect(inSession).toHaveBeenCalledWith(err);
  });
});
