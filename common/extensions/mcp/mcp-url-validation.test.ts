// Marshal ownership: relocated module identity.
import { describe, it, expect } from "vitest";

import { validateMcpUrl } from "./mcp-url-validation";

describe("validateMcpUrl", () => {
  describe("valid https URLs", () => {
    it("accepts https remote URL", () => {
      const result = validateMcpUrl("https://api.example.com/mcp");
      expect(result).toEqual({ ok: true, isLocalhost: false });
    });

    it("accepts https URL with port", () => {
      const result = validateMcpUrl("https://api.example.com:8443/mcp");
      expect(result).toEqual({ ok: true, isLocalhost: false });
    });

    it("accepts https localhost", () => {
      const result = validateMcpUrl("https://localhost:3000");
      expect(result).toEqual({ ok: true, isLocalhost: true });
    });
  });

  describe("valid http localhost URLs", () => {
    it("accepts http://localhost", () => {
      const result = validateMcpUrl("http://localhost");
      expect(result).toEqual({ ok: true, isLocalhost: true });
    });

    it("accepts http://localhost with port", () => {
      const result = validateMcpUrl("http://localhost:8080");
      expect(result).toEqual({ ok: true, isLocalhost: true });
    });

    it("accepts http://127.0.0.1", () => {
      const result = validateMcpUrl("http://127.0.0.1:3000");
      expect(result).toEqual({ ok: true, isLocalhost: true });
    });

    it("accepts http://[::1] (IPv6 loopback)", () => {
      // URL parser normalizes [::1] — hostname is "[::1]" (with brackets)
      const result = validateMcpUrl("http://[::1]:3000");
      expect(result).toEqual({ ok: true, isLocalhost: true });
    });
  });

  describe("rejected URLs", () => {
    it.each([
      ["http:// for external hosts", "http://evil.com", /https:\/\//],
      ["file:// URLs", "file:///etc/passwd", /file/],
      ["ftp:// URLs", "ftp://files.example.com", /ftp/],
    ])("rejects %s", (_label, input, reasonRegex) => {
      const result = validateMcpUrl(input);
      // Cast helper would be overkill for one-field result; assert directly
      // by switching on the discriminator and using the negation throw-guard.
      if (result.ok) throw new Error(`expected validation failure for ${input}`);
      expect(result.reason).toMatch(reasonRegex);
    });

    it("rejects data: URLs", () => {
      const result = validateMcpUrl("data:text/plain,hello");
      expect(result.ok).toBe(false);
    });

    it("rejects malformed URL", () => {
      const result = validateMcpUrl("not-a-url");
      expect(result).toEqual({ ok: false, reason: "Invalid URL format." });
    });

    it("rejects empty string", () => {
      const result = validateMcpUrl("");
      expect(result.ok).toBe(false);
    });

    it("rejects URL with only scheme", () => {
      const result = validateMcpUrl("https://");
      expect(result.ok).toBe(false);
    });
  });
});
