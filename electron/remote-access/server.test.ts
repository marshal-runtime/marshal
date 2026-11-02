import { once } from "node:events";
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";

import { RUNTIME_UI_SANDBOX_CSP_SOURCE } from "../../common/runtime-ui-sandbox";
import { RemoteAccessServer } from "./server";

describe("private remote server", () => {
  let server: RemoteAccessServer, dir: string, base: string, cookie: string;
  const invoke = vi.fn<() => Promise<{ success: boolean }>>(async () => ({ success: true }));
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "marshal-remote-"));
    await writeFile(path.join(dir, "remote.html"), "<h1>Marshal</h1>");
    await mkdir(path.join(dir, "media"));
    server = new RemoteAccessServer({
      port: 0,
      origin: "https://test.tail.ts.net",
      secret: "a".repeat(43),
      rendererDir: dir,
      invoke,
      removeTarget: vi.fn<(id: number) => void>(),
      mediaRoots: () => [path.join(dir, "media")],
      uploadDir: path.join(dir, "uploads"),
    });
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    invoke.mockClear();
  });
  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function login() {
    const response = await fetch(base + "/remote/login", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "a".repeat(43) }),
    });
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    return response;
  }
  async function connect() {
    await login();
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", {
      headers: { Origin: base, Cookie: cookie },
    });
    await once(ws, "open");
    return ws;
  }
  it("permits the packaged-UI sandbox in the page CSP (M1: srcdoc iframes inherit it)", async () => {
    // The packaged sandbox executes a hash-pinned inline bootstrap that
    // re-runs app scripts as blob: URLs. srcdoc iframes inherit THIS header's
    // policy (the srcdoc meta CSP can only tighten it), so without the
    // bootstrap hash and blob: the phone shows "The application did not
    // initialize" while the desktop (electron/main.ts script-src) works.
    const response = await fetch(base + "/remote.html", { headers: { Origin: base } });
    const csp = response.headers.get("content-security-policy") ?? "";
    const scriptSrc = csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("script-src "));
    expect(scriptSrc).toContain("blob:");
    expect(scriptSrc).toContain(RUNTIME_UI_SANDBOX_CSP_SOURCE);
    // The page's own hardening stays: no unsafe-inline / unsafe-eval scripts.
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("serves login assets but denies unauthenticated data and foreign login origins", async () => {
    expect((await fetch(base)).status).toBe(200);
    expect((await fetch(base + "/remote/status")).status).toBe(401);
    expect((await fetch(base + "/remote/media?path=/etc/passwd")).status).toBe(401);
    expect(
      (
        await fetch(base + "/remote/login", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });
  it("compresses app files and lets the phone cache hashed assets", async () => {
    const source = `export const app = "${"x".repeat(4096)}";`;
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "assets", "main-AbCd1234.js"), source);
    await Promise.all(
      ["br", "gzip"].map(async (encoding) => {
        const asset = await fetch(base + "/assets/main-AbCd1234.js", {
          headers: { "Accept-Encoding": encoding },
        });
        expect(asset.headers.get("content-encoding")).toBe(encoding);
        expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(Number(asset.headers.get("content-length"))).toBeLessThan(source.length / 4);
        expect(await asset.text()).toBe(source);
      }),
    );
    const page = await fetch(base + "/remote.html");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toBe("<h1>Marshal</h1>");
  });
  it("sets an HttpOnly SameSite cookie and rejects a wrong key", async () => {
    const bad = await fetch(base + "/remote/login", {
      method: "POST",
      headers: { Origin: base },
      body: JSON.stringify({ secret: "wrong" }),
    });
    expect(bad.status).toBe(401);
    const good = await login();
    expect(good.headers.get("set-cookie")).toContain("HttpOnly");
    expect(good.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect((await fetch(base + "/remote/status", { headers: { Cookie: cookie } })).status).toBe(
      200,
    );
  });
  it("uses Secure cookies behind the configured private HTTPS origin", async () => {
    const response = await fetch(base + "/remote/login", {
      method: "POST",
      headers: { Host: "test.tail.ts.net", Origin: "https://test.tail.ts.net" },
      body: JSON.stringify({ secret: "a".repeat(43) }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("; Secure");
  });
  it("dispatches allowlisted validated calls and preserves optional IPC arguments", async () => {
    const ws = await connect();
    const response = once(ws, "message");
    ws.send(JSON.stringify({ type: "req", id: "1", method: "sessions:list", args: [] }));
    expect(JSON.parse(String((await response)[0])).ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      "sessions:list",
      [undefined],
      expect.any(Number),
      expect.objectContaining({ id: expect.any(Number), send: expect.any(Function) }),
    );
    ws.close();
  });
  it("rejects desktop-only operations and implicit active-session send", async () => {
    const ws = await connect();
    for (const request of [
      { method: "workspace:writeFile", args: ["/tmp/file", "oops"] },
      { method: "copilot:send", args: ["hello"] },
      { method: "sessions:create", args: [null, null, { source: "user", setActive: true }] },
    ]) {
      const response = once(ws, "message");
      ws.send(JSON.stringify({ type: "req", id: "1", ...request }));
      // eslint-disable-next-line no-await-in-loop -- Each request/response pair must be matched sequentially.
      expect(JSON.parse(String((await response)[0])).ok).toBe(false);
    }
    expect(invoke).not.toHaveBeenCalled();
    ws.close();
  });
  it("rejects authenticated cross-origin websocket upgrades", async () => {
    await login();
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", {
      headers: { Origin: "https://evil.example", Cookie: cookie },
    });
    await expect(once(ws, "open")).rejects.toThrow("Unexpected server response: 403");
  });
  it("confines media including symlink escapes", async () => {
    await login();
    const outside = path.join(dir, "outside.png");
    await writeFile(outside, "private");
    await symlink(outside, path.join(dir, "media", "escape.png"));
    await writeFile(path.join(dir, "media", "ok.png"), "image");
    const get = (p: string) =>
      fetch(base + "/remote/media?path=" + encodeURIComponent(p), { headers: { Cookie: cookie } });
    expect((await get(outside)).status).toBe(403);
    expect((await get(path.join(dir, "media", "escape.png"))).status).toBe(403);
    expect(await (await get(path.join(dir, "media", "ok.png"))).text()).toBe("image");
  });
  it("uploads bytes to an owned path and refuses unauthenticated uploads", async () => {
    const upload = (headers: Record<string, string>) =>
      fetch(base + "/remote/upload", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "../../notes.txt",
          data: Buffer.from("phone attachment").toString("base64"),
        }),
      });
    expect((await upload({ Origin: base })).status).toBe(403);
    await login();
    const response = await upload({ Origin: base, Cookie: cookie });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.path.startsWith(path.join(dir, "uploads") + path.sep)).toBe(true);
    expect(await readFile(result.path, "utf8")).toBe("phone attachment");
  });
  it("only broadcasts approved events and disconnects targets on shutdown", async () => {
    const ws = await connect();
    expect(server.getTargets()).toHaveLength(1);
    const response = once(ws, "message");
    server.broadcast("telemetry:logEvent", { private: true });
    server.broadcast("settings:changed");
    expect(JSON.parse(String((await response)[0])).event).toBe("settings:changed");
    await server.close();
    expect(server.getTargets()).toHaveLength(0);
  });
});
