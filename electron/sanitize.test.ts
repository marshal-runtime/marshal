import * as os from "os";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return { ...actual, homedir: vi.fn<() => string>(() => "/Users/testuser") };
});

import { sanitizeForTelemetry, redactForDisplay } from "./marshal-value-sanitization";

const mockedHomedir = vi.mocked(os.homedir);

describe("sanitizeForTelemetry", () => {
  beforeEach(() => {
    mockedHomedir.mockReturnValue("/Users/testuser");
  });

  // ── Home path redaction ──────────────────────────────────────────────

  it("replaces macOS home directory paths with ~", () => {
    const input = "Error at /Users/testuser/Work/m/src/App.tsx:42";
    expect(sanitizeForTelemetry(input)).toBe("Error at ~/Work/m/src/App.tsx:42");
  });

  it("replaces Linux home directory paths with ~", () => {
    mockedHomedir.mockReturnValue("/home/testuser");
    const input = "Error at /home/testuser/.config/app/crash.log";
    expect(sanitizeForTelemetry(input)).toBe("Error at ~/.config/app/crash.log");
  });

  it("replaces Windows home directory paths with ~", () => {
    mockedHomedir.mockReturnValue("C:\\Users\\testuser");
    const input = "Error at C:\\Users\\testuser\\AppData\\Local\\app\\crash.log";
    expect(sanitizeForTelemetry(input)).toBe("Error at ~\\AppData\\Local\\app\\crash.log");
  });

  it("replaces Windows paths with forward slashes", () => {
    mockedHomedir.mockReturnValue("C:\\Users\\testuser");
    const input = "Error at C:/Users/testuser/AppData/Local/app/crash.log";
    expect(sanitizeForTelemetry(input)).toBe("Error at ~/AppData/Local/app/crash.log");
  });

  it("handles multiple home dir occurrences", () => {
    const input = "/Users/testuser/a.ts and /Users/testuser/b.ts";
    expect(sanitizeForTelemetry(input)).toBe("~/a.ts and ~/b.ts");
  });

  // ── Other user path redaction ────────────────────────────────────────

  it("redacts other users' home paths with positive assertion", () => {
    const input = "at Component (/Users/otheruser/Work/m/src/App.tsx:42:5)";
    const result = sanitizeForTelemetry(input);
    expect(result).not.toContain("otheruser");
    expect(result).toContain("~/Work/m/src/App.tsx:42:5");
  });

  it("redacts other users' Windows paths with positive assertion", () => {
    mockedHomedir.mockReturnValue("C:\\Users\\testuser");
    const input = "at Component (C:\\Users\\someone\\project\\file.ts:10)";
    const result = sanitizeForTelemetry(input);
    expect(result).not.toContain("someone");
    expect(result).toContain("~");
  });

  it("redacts Linux /home/ paths with positive assertion", () => {
    mockedHomedir.mockReturnValue("/home/testuser");
    const input = "at fn (/home/otherdev/.local/lib/module.js:5)";
    const result = sanitizeForTelemetry(input);
    expect(result).not.toContain("otherdev");
    expect(result).toContain("~");
  });

  it("redacts JSON-escaped Windows paths (double backslash)", () => {
    mockedHomedir.mockReturnValue("C:\\Users\\testuser");
    const input = '{"file":"C:\\\\Users\\\\someone\\\\project\\\\file.ts"}';
    const result = sanitizeForTelemetry(input);
    expect(result).not.toContain("someone");
    expect(result).toContain("~");
  });

  it("redacts case-insensitive Windows Users path", () => {
    const input = "at fn (c:/users/someone/foo.txt)";
    const result = sanitizeForTelemetry(input);
    expect(result).not.toContain("someone");
    expect(result).toContain("~");
  });

  // ── Email redaction ──────────────────────────────────────────────────

  it("redacts email addresses", () => {
    const input = "User john.doe@example.com triggered error";
    expect(sanitizeForTelemetry(input)).toBe("User <email> triggered error");
  });

  it("redacts multiple email addresses", () => {
    const input = "from alice@corp.com to bob@corp.com";
    expect(sanitizeForTelemetry(input)).toBe("from <email> to <email>");
  });

  // ── Secret redaction ─────────────────────────────────────────────────

  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig";
    const result = sanitizeForTelemetry(input);
    expect(result).toContain("<auth-redacted>");
    expect(result).not.toContain("eyJhbGci");
  });

  it("redacts access_token query params", () => {
    const input = "https://api.example.com/v1.0/me?access_token=abc123def456";
    expect(sanitizeForTelemetry(input)).toContain("access_token=<redacted>");
    expect(sanitizeForTelemetry(input)).not.toContain("abc123def456");
  });

  it("redacts refresh_token and client_secret params", () => {
    const input = "refresh_token=xyz789&client_secret=secret123";
    const result = sanitizeForTelemetry(input);
    expect(result).toContain("refresh_token=<redacted>");
    expect(result).toContain("client_secret=<redacted>");
  });

  it("redacts JWT-like tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(sanitizeForTelemetry(`Token: ${jwt}`)).toContain("<jwt-redacted>");
  });

  it("redacts SAS signature params", () => {
    const input = "https://storage.blob.core.windows.net/container?sig=abc123&token=def456";
    const result = sanitizeForTelemetry(input);
    expect(result).toContain("sig=<redacted>");
    expect(result).toContain("token=<redacted>");
  });

  it("redacts AccountKey in connection strings", () => {
    const input =
      "DefaultEndpointsProtocol=https;AccountKey=abc123secret;EndpointSuffix=core.windows.net";
    const result = sanitizeForTelemetry(input);
    expect(result).toContain("AccountKey=<redacted>");
    expect(result).not.toContain("abc123secret");
  });

  it("redacts JSON-style secret fields", () => {
    const input = '{"access_token":"secret123","client_secret":"key456"}';
    const result = sanitizeForTelemetry(input);
    expect(result).not.toContain("secret123");
    expect(result).not.toContain("key456");
    expect(result).toContain('"access_token":"<redacted>"');
  });

  it("redacts util.inspect-style secret fields", () => {
    const input = "{ access_token: 'secret123', client_secret: 'key456' }";
    const result = sanitizeForTelemetry(input);

    expect(result).not.toContain("secret123");
    expect(result).not.toContain("key456");
    expect(result).toContain("access_token: '<redacted>'");
    expect(result).toContain("client_secret: '<redacted>'");
  });

  // ── Truncation ───────────────────────────────────────────────────────

  it("truncates strings longer than 4096 characters", () => {
    const input = "x".repeat(5000);
    const result = sanitizeForTelemetry(input);
    expect(result.length).toBeLessThanOrEqual(4096 + "…[truncated]".length);
    expect(result).toContain("…[truncated]");
  });

  it("does not truncate strings at or below 4096 characters", () => {
    const input = "x".repeat(4096);
    expect(sanitizeForTelemetry(input)).toBe(input);
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  it("returns empty string unchanged", () => {
    expect(sanitizeForTelemetry("")).toBe("");
  });

  it("leaves clean error messages unchanged", () => {
    const input = "TypeError: Cannot read property 'foo' of undefined";
    expect(sanitizeForTelemetry(input)).toBe(input);
  });

  it("coerces undefined to empty string", () => {
    expect(sanitizeForTelemetry(undefined)).toBe("");
  });

  it("coerces null to empty string", () => {
    expect(sanitizeForTelemetry(null)).toBe("");
  });

  it("coerces numbers to string", () => {
    expect(sanitizeForTelemetry(42)).toBe("42");
  });

  it("coerces objects to JSON string", () => {
    expect(sanitizeForTelemetry({ code: "ERR" })).toBe('{"code":"ERR"}');
  });

  it("handles circular objects gracefully", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(sanitizeForTelemetry(circular)).toBe("[unserializable]");
  });

  it("handles realistic error stack with paths and frames", () => {
    const input = [
      "Error: Something broke",
      "    at Component (/Users/testuser/Work/m/src/App.tsx:42:5)",
      "    at renderWithHooks (/Users/testuser/Work/m/node_modules/react/index.js:100:3)",
    ].join("\n");
    const result = sanitizeForTelemetry(input);
    expect(result).not.toContain("testuser");
    expect(result).toContain("~/Work/m/src/App.tsx:42:5");
  });
});

describe("redactForDisplay", () => {
  beforeEach(() => {
    mockedHomedir.mockReturnValue("/Users/testuser");
  });

  it("redacts home directory paths", () => {
    expect(redactForDisplay("file at /Users/testuser/docs/x.txt")).toBe("file at ~/docs/x.txt");
  });

  it("redacts /Users/<username> style paths", () => {
    expect(redactForDisplay("path: /Users/alice/Projects/foo")).toBe("path: ~/Projects/foo");
  });

  it("redacts email addresses", () => {
    const out = redactForDisplay("contact alice@example.com for help");
    expect(out).not.toContain("alice@example.com");
    expect(out).toContain("<email>");
  });

  it("redacts JWT-style secrets", () => {
    // Real JWT-shaped token: header.payload.signature where header and payload start with eyJ
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9." + "A".repeat(40);
    const out = redactForDisplay(`token: ${jwt}`);
    expect(out).not.toContain(jwt);
  });

  it("does NOT truncate input longer than 4096 characters", () => {
    const input = "x".repeat(10_000);
    expect(redactForDisplay(input).length).toBe(10_000);
  });

  it("for input ≤ 4096 with no PII, redactForDisplay and sanitizeForTelemetry produce the same output", () => {
    const input = "Something went wrong at ~/Work/m/src/App.tsx:42";
    expect(redactForDisplay(input)).toBe(sanitizeForTelemetry(input));
  });

  it("for input > 4096, redactForDisplay preserves length while sanitizeForTelemetry truncates", () => {
    const input = "a".repeat(5000);
    expect(redactForDisplay(input).length).toBe(5000);
    expect(sanitizeForTelemetry(input).length).toBeLessThan(5000);
  });
});
