import { describe, it, expect, vi, beforeEach } from "vitest";

const { readFile } = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<Buffer>>(),
}));
vi.mock("node:fs/promises", () => ({ readFile }));

import { makeMarshalHandler } from "./marshal-protocol";

const handler = makeMarshalHandler("/app/dist");
const req = (url: string, method = "GET") => new Request(url, { method });

describe("makeMarshalHandler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readFile.mockResolvedValue(Buffer.from("body"));
  });
  it("serves index and assets with safe content types", async () => {
    readFile.mockResolvedValue(Buffer.from("<!doctype html>"));
    const res = await handler(req("marshal://app/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining("dist/index.html"));
    expect((await handler(req("marshal://app/assets/main.js"))).status).toBe(200);
  });
  it("blocks invalid methods, hosts, and traversal", async () => {
    expect((await handler(req("marshal://app/index.html", "POST"))).status).toBe(405);
    expect((await handler(req("marshal://untrusted/index.html"))).status).toBe(404);
    readFile.mockRejectedValue(new Error("missing"));
    expect((await handler(req("marshal://app/../../../etc/passwd"))).status).toBe(404);
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining("/app/dist"));
  });
  it("returns 404 for missing files and supports HEAD", async () => {
    readFile.mockRejectedValue(new Error("missing"));
    expect((await handler(req("marshal://app/assets/missing.js"))).status).toBe(404);
    readFile.mockResolvedValue(Buffer.from("body"));
    const res = await handler(req("marshal://app/index.html", "HEAD"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
