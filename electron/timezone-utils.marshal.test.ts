// Marshal-owned test
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeProcessTZ, toIANATimezone } from "./timezone-utils";

describe("toIANATimezone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns IANA names as-is when Intl accepts them", () => {
    expect(toIANATimezone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(toIANATimezone("Europe/London")).toBe("Europe/London");
    expect(toIANATimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(toIANATimezone("UTC")).toBe("UTC");
  });

  it("maps common Windows timezone names to IANA", () => {
    expect(toIANATimezone("Pacific Standard Time")).toBe("America/Los_Angeles");
    expect(toIANATimezone("Mountain Standard Time")).toBe("America/Denver");
    expect(toIANATimezone("Central Standard Time")).toBe("America/Chicago");
    expect(toIANATimezone("Eastern Standard Time")).toBe("America/New_York");
    expect(toIANATimezone("GMT Standard Time")).toBe("Europe/London");
    expect(toIANATimezone("W. Europe Standard Time")).toBe("Europe/Berlin");
    expect(toIANATimezone("India Standard Time")).toBe("Asia/Kolkata");
    expect(toIANATimezone("China Standard Time")).toBe("Asia/Shanghai");
    expect(toIANATimezone("Tokyo Standard Time")).toBe("Asia/Tokyo");
    expect(toIANATimezone("AUS Eastern Standard Time")).toBe("Australia/Sydney");
  });

  it("falls back to UTC for unknown names and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(toIANATimezone("Not A Real Timezone")).toBe("UTC");
    // createLogger emits through a consoleSink that prepends a `[TimezoneUtils]`
    // tag, so the spy sees the tag as the first arg and the message as the
    // second. Just assert the warning fired — the tag/message split is an
    // implementation detail of the shared logger.
    expect(warn).toHaveBeenCalled();
    const flat = warn.mock.calls.flat().join(" ");
    expect(flat).toContain('Unknown timezone "Not A Real Timezone"');
  });

  it("falls back to UTC for empty string and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(toIANATimezone("")).toBe("UTC");
    expect(warn).toHaveBeenCalled();
  });

  it("regression: Pacific Standard Time round-trips to a PDT-formatting zone", () => {
    // The reported bug: "Pacific Standard Time" caused Intl to throw and the
    // per-turn date anchor fell back to ISO UTC format. Lock the fix in with
    // a direct formatter round-trip for the exact user-observed timestamp.
    const iana = toIANATimezone("Pacific Standard Time");
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date("2026-04-23T00:39:00Z"));
    expect(formatted).toContain("Wednesday");
    expect(formatted).toContain("April 22, 2026");
    expect(formatted).toContain("PDT");
  });
});

describe("normalizeProcessTZ", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rewrites a Windows-format ID to its IANA equivalent", () => {
    const env: Partial<NodeJS.ProcessEnv> = { TZ: "Pacific Standard Time" };
    normalizeProcessTZ(env);
    expect(env.TZ).toBe("America/Los_Angeles");
  });

  it("rewrites every entry in WINDOWS_TO_IANA (smoke check)", () => {
    // A few representative entries — the underlying mapping is exercised by
    // toIANATimezone's tests. We just want to confirm normalizeProcessTZ
    // wires through to the same table.
    const cases = [
      ["Eastern Standard Time", "America/New_York"],
      ["GMT Standard Time", "Europe/London"],
      ["Tokyo Standard Time", "Asia/Tokyo"],
    ] as const;
    for (const [input, expected] of cases) {
      const env: Partial<NodeJS.ProcessEnv> = { TZ: input };
      normalizeProcessTZ(env);
      expect(env.TZ).toBe(expected);
    }
  });

  it("passes a valid IANA name through unchanged", () => {
    const env: Partial<NodeJS.ProcessEnv> = { TZ: "America/Los_Angeles" };
    normalizeProcessTZ(env);
    expect(env.TZ).toBe("America/Los_Angeles");
  });

  it("preserves an explicit UTC", () => {
    const env: Partial<NodeJS.ProcessEnv> = { TZ: "UTC" };
    normalizeProcessTZ(env);
    expect(env.TZ).toBe("UTC");
  });

  it("DELETES TZ for a Windows ID outside the mapping table (Tonga regression)", () => {
    // The first revision of this fix stamped TZ="UTC" for unmapped input,
    // which locked V8 into UTC for users in regions outside our 42-entry
    // CLDR subset. The correct fallback is to delete TZ and let V8 use OS
    // detection. Lock that policy in here.
    const env: Partial<NodeJS.ProcessEnv> = { TZ: "Tonga Standard Time" };
    normalizeProcessTZ(env);
    expect(env.TZ).toBeUndefined();
  });

  it("DELETES TZ for total junk", () => {
    const env: Partial<NodeJS.ProcessEnv> = { TZ: "garbage" };
    normalizeProcessTZ(env);
    expect(env.TZ).toBeUndefined();
  });

  it("DELETES TZ when set to 'Etc/Unknown' (V8 silently UTCs that)", () => {
    const env: Partial<NodeJS.ProcessEnv> = { TZ: "Etc/Unknown" };
    normalizeProcessTZ(env);
    expect(env.TZ).toBeUndefined();
  });

  // Helper: stub Intl.DateTimeFormat() (no-arg) to return a specific tz while
  // leaving Intl.DateTimeFormat("en-US", { timeZone }) (used by isParseableIANA
  // for validation) working against the real ICU. Direct assignment +
  // afterEach restore is more reliable than vi.spyOn for built-ins that are
  // also invoked with `new`.
  type IntlHolder = { DateTimeFormat: typeof Intl.DateTimeFormat };
  let originalDateTimeFormat: typeof Intl.DateTimeFormat | null = null;
  function stubIntlNoArg(timeZone: string | undefined): void {
    if (!originalDateTimeFormat) originalDateTimeFormat = Intl.DateTimeFormat;
    const Original = originalDateTimeFormat;
    const stub = function (...args: unknown[]) {
      if (args.length === 0) {
        return { resolvedOptions: () => ({ timeZone }) };
      }
      return Reflect.construct(Original, args);
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only Intl shim, narrowing intentional
    (Intl as IntlHolder).DateTimeFormat = stub as unknown as typeof Intl.DateTimeFormat;
  }
  afterEach(() => {
    if (originalDateTimeFormat) {
      (Intl as IntlHolder).DateTimeFormat = originalDateTimeFormat;
      originalDateTimeFormat = null;
    }
  });

  it("when TZ is unset, resolves from Intl if usable", () => {
    stubIntlNoArg("Europe/Berlin");
    const env: Partial<NodeJS.ProcessEnv> = {};
    normalizeProcessTZ(env);
    expect(env.TZ).toBe("Europe/Berlin");
  });

  it("when TZ is unset and Intl returns Etc/Unknown, leaves TZ unset", () => {
    stubIntlNoArg("Etc/Unknown");
    const env: Partial<NodeJS.ProcessEnv> = {};
    normalizeProcessTZ(env);
    expect(env.TZ).toBeUndefined();
  });

  it("when TZ is unset and Intl returns undefined, leaves TZ unset", () => {
    stubIntlNoArg(undefined);
    const env: Partial<NodeJS.ProcessEnv> = {};
    normalizeProcessTZ(env);
    expect(env.TZ).toBeUndefined();
  });

  it("when TZ is unset and Intl throws, leaves TZ unset", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("ICU borked");
    });

    const env: Partial<NodeJS.ProcessEnv> = {};
    normalizeProcessTZ(env);
    expect(env.TZ).toBeUndefined();
  });

  it("logs an info line on the happy passthrough path", () => {
    // The shared logger routes info/debug to console.log (see common/marshal-logger.ts
    // consoleSink), with a "[TimezoneUtils]" tag prepended. Spy on console.log
    // and search the flattened output.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const env: Partial<NodeJS.ProcessEnv> = { TZ: "America/Los_Angeles" };
    normalizeProcessTZ(env);
    expect(logSpy).toHaveBeenCalled();
    const flat = logSpy.mock.calls.flat().join(" ");
    expect(flat).toContain("America/Los_Angeles");
  });

  it("logs a warn line when deleting an unparseable TZ", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env: Partial<NodeJS.ProcessEnv> = { TZ: "Tonga Standard Time" };
    normalizeProcessTZ(env);
    expect(warn).toHaveBeenCalled();
    const flat = warn.mock.calls.flat().join(" ");
    expect(flat).toContain("Tonga Standard Time");
    expect(flat).toMatch(/unparseable|delet/i);
  });
});
