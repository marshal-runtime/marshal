// Marshal-owned tooling test.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { httpRequest } from "../src/marshal-review-http-client.ts";
import { startHttpServer, type Router } from "../src/marshal-review-http-server.ts";

let cleanupPath: string | null = null;

afterEach(async () => {
  if (cleanupPath && process.platform !== "win32") {
    await fs.rm(cleanupPath, { force: true });
  }
  cleanupPath = null;
});

const route =
  (handler: (req: Record<string, unknown>) => Promise<unknown>): Router =>
  async (m, p, b) => {
    if (m === "GET" && p === "/status") return { status: 200, body: { ok: true } };
    if (m === "POST" && p === "/echo") {
      const obj =
        typeof b === "object" && b !== null && !Array.isArray(b)
          ? // Test-only handler — body shape is whatever the test sent.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            (b as Record<string, unknown>)
          : {};
      return { status: 200, body: await handler(obj) };
    }
    return { status: 404, body: { error: "not found" } };
  };

describe("socket transport", () => {
  it("starts a server on a unix socket / named pipe, round-trips JSON GET and POST", async () => {
    const sock =
      process.platform === "win32"
        ? `\\\\.\\pipe\\m-rq-test-${process.pid}-${Date.now()}`
        : path.join(os.tmpdir(), `m-rq-test-${process.pid}-${Date.now()}.sock`);
    cleanupPath = sock;

    const server = await startHttpServer({ socketPath: sock, router: route(async (b) => b) });
    try {
      const get = await httpRequest({ socketPath: sock, method: "GET", path: "/status" });
      expect(get.status).toBe(200);
      expect(JSON.parse(get.body)).toEqual({ ok: true });

      const post = await httpRequest({
        socketPath: sock,
        method: "POST",
        path: "/echo",
        body: { hello: "world" },
      });
      expect(post.status).toBe(200);
      expect(JSON.parse(post.body)).toEqual({ hello: "world" });
    } finally {
      await server.close();
    }
  });
});
