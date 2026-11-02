// Marshal-owned test
import { describe, expect, it } from "vitest";

import { getDevServerUrl, isDevServerNavigation } from "./runtime-env";

describe("getDevServerUrl", () => {
  it("ignores VITE_DEV_SERVER_URL in packaged builds", () => {
    expect(getDevServerUrl(true, "http://127.0.0.1:5173/")).toBeUndefined();
  });

  it("returns undefined when VITE_DEV_SERVER_URL is unset in dev builds", () => {
    expect(getDevServerUrl(false, undefined)).toBeUndefined();
  });

  it("allows localhost dev server URLs in dev builds", () => {
    expect(getDevServerUrl(false, "http://localhost:5173/")).toBe("http://localhost:5173");
    expect(getDevServerUrl(false, "http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173");
    expect(getDevServerUrl(false, "http://[::1]:5173/")).toBe("http://[::1]:5173");
  });

  it("rejects non-localhost dev server URLs in dev builds", () => {
    expect(() => getDevServerUrl(false, "http://evil.example.com:5173/")).toThrow(/localhost/i);
  });

  it("rejects malformed dev server URLs in dev builds", () => {
    expect(() => getDevServerUrl(false, "not-a-url")).toThrow(/valid URL/i);
  });
});

describe("isDevServerNavigation", () => {
  it("allows same-origin dev server navigations", () => {
    expect(
      isDevServerNavigation("http://localhost:5173", "http://localhost:5173/src/App.tsx"),
    ).toBe(true);
  });

  it("rejects sibling ports that share a string prefix", () => {
    expect(isDevServerNavigation("http://localhost:5173", "http://localhost:51730/path")).toBe(
      false,
    );
  });

  it("rejects malformed navigation URLs", () => {
    expect(isDevServerNavigation("http://localhost:5173", "not-a-url")).toBe(false);
  });
});
