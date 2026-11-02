// Marshal-owned module.
import { describe, it, expect } from "vitest";

import { parseCatalogContent } from "./parseCatalogContent";

describe("parseCatalogContent", () => {
  it("parses first-party content with args", () => {
    const source = { type: "first-party" as const, content: '{"args":["--port","3000"]}' };
    expect(parseCatalogContent(source)).toEqual({ args: ["--port", "3000"] });
  });

  it("returns null for bundled source", () => {
    expect(parseCatalogContent({ type: "bundled" })).toBeNull();
  });

  it("returns null for github source", () => {
    expect(parseCatalogContent({ type: "github", repo: "org/repo", path: "SKILL.md" })).toBeNull();
  });

  it("returns null for url source", () => {
    expect(parseCatalogContent({ type: "url", url: "https://example.com" })).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    const source = { type: "first-party" as const, content: "not-json{" };
    expect(parseCatalogContent(source)).toBeNull();
  });

  it("returns parsed object even without args field", () => {
    const source = { type: "first-party" as const, content: '{"command":"node"}' };
    expect(parseCatalogContent(source)).toEqual({ command: "node" });
  });

  it("returns null for JSON array content", () => {
    const source = { type: "first-party" as const, content: '["a","b"]' };
    expect(parseCatalogContent(source)).toBeNull();
  });

  it("returns null for JSON string content", () => {
    const source = { type: "first-party" as const, content: '"hello"' };
    expect(parseCatalogContent(source)).toBeNull();
  });

  it("returns null for JSON null content", () => {
    const source = { type: "first-party" as const, content: "null" };
    expect(parseCatalogContent(source)).toBeNull();
  });
});
