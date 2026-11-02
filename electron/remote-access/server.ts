import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";

import { RUNTIME_UI_SANDBOX_CSP_SOURCE } from "../../common/runtime-ui-sandbox";
import type { SessionViewIpcTarget } from "../session-view-ipc-broker";
import { remoteEvents, validateRemoteArgs } from "./policy";
import type { RemoteEventSender } from "./shared-handlers";

export interface RemoteAccessOptions {
  port: number;
  origin?: string;
  secret: string;
  rendererDir: string;
  invoke: (
    method: string,
    args: unknown[],
    targetId: number,
    sender: RemoteEventSender,
  ) => Promise<unknown>;
  removeTarget: (id: number) => void;
  onConnect?: (id: number) => void;
  mediaRoots?: () => string[];
  uploadDir?: string;
}
const MAX_BYTES = 20 * 1024 * 1024;
const COOKIE = "marshal_remote";
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const digest = (s: string) => createHash("sha256").update(s).digest();
const compressible = new Set([".html", ".js", ".css", ".json", ".webmanifest", ".svg"]);
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const COMPRESSED_CACHE_LIMIT = 256;
type Encoding = "br" | "gzip";
function preferredEncoding(req: IncomingMessage): Encoding | null {
  const accepted = req.headers["accept-encoding"] ?? "";
  if (/\bbr\b/.test(accepted)) return "br";
  if (/\bgzip\b/.test(accepted)) return "gzip";
  return null;
}
export class RemoteAccessServer {
  private readonly sockets = new Map<number, WebSocket>();
  private nextId = -1;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BYTES,
    perMessageDeflate: false,
  });
  private readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => {
      if (!res.headersSent) this.json(res, 500, { error: "Remote request failed" });
      else res.end();
    });
  });
  private loginAttempts = 0;
  private loginWindow = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly alive = new WeakSet<WebSocket>();
  private readonly compressed = new Map<string, Promise<Buffer>>();
  constructor(private readonly options: RemoteAccessOptions) {
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 15_000;
    this.server.maxConnections = 32;
    if (options.secret.length < 32)
      throw new Error("Remote access secret must contain at least 32 characters");
    if (options.origin && !/^https:\/\/[a-z0-9.-]+\.ts\.net$/.test(options.origin))
      throw new Error("Remote origin must be a private Tailscale HTTPS origin");
    this.server.on("upgrade", (req, socket, head) => {
      if (
        req.url !== "/ws" ||
        !this.validHost(req) ||
        !this.validOrigin(req) ||
        !this.authenticated(req) ||
        this.sockets.size >= 8
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.heartbeat = setInterval(() => {
      for (const ws of this.sockets.values()) {
        if (!this.alive.has(ws)) {
          ws.terminate();
          continue;
        }
        this.alive.delete(ws);
        ws.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }
  get port(): number {
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : this.options.port;
  }
  getTargets(): SessionViewIpcTarget[] {
    return [...this.sockets].map(([id, ws]) => ({
      id,
      isDestroyed: () => ws.readyState !== WebSocket.OPEN,
      send: (channel, payload) => this.send(ws, channel, [payload]),
    }));
  }
  broadcast(channel: string, ...args: unknown[]): void {
    if (!remoteEvents.has(channel)) return;
    for (const ws of this.sockets.values()) this.send(ws, channel, args);
  }
  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const [id, ws] of this.sockets) {
      this.options.removeTarget(id);
      ws.terminate();
    }
    this.sockets.clear();
    this.wss.close();
    if (this.server.listening) {
      const closing = new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.server.closeAllConnections();
      await closing;
    }
  }
  private send(ws: WebSocket, event: string, args: unknown[]): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BYTES) {
      ws.close(1013, "Reconnect to refresh");
      return;
    }
    ws.send(JSON.stringify({ type: "event", event, args }));
  }
  private signature(s: string): string {
    return createHmac("sha256", this.options.secret).update(s).digest("base64url");
  }
  private authenticated(req: IncomingMessage): boolean {
    const token = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!token) return false;
    const [expiry, nonce, sig] = token.split(".");
    if (!expiry || !nonce || !sig || Number(expiry) < Date.now()) return false;
    return timingSafeEqual(digest(sig), digest(this.signature(`${expiry}.${nonce}`)));
  }
  private validHost(req: IncomingMessage): boolean {
    return (
      req.headers.host === `127.0.0.1:${this.port}` ||
      req.headers.host === `localhost:${this.port}` ||
      (!!this.options.origin && req.headers.host === new URL(this.options.origin).host)
    );
  }
  private validOrigin(req: IncomingMessage): boolean {
    return (
      req.headers.origin === `http://127.0.0.1:${this.port}` ||
      req.headers.origin === `http://localhost:${this.port}` ||
      (!!this.options.origin && req.headers.origin === this.options.origin)
    );
  }
  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  }
  private async body(req: IncomingMessage, limit: number): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error("Request too large");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    // script-src carries the packaged-UI sandbox allowances (the hash-pinned
    // bootstrap + its blob: re-execution), mirroring the desktop renderer's
    // policy (electron/main.ts): srcdoc iframes INHERIT this header, and the
    // sandbox document's own meta CSP can only tighten it. Without these the
    // packaged app's ui/initialize never runs on the phone (defect M1). blob:
    // scripts are only mintable by already-running trusted code, so the page's
    // own hardening (no unsafe-inline/eval, no remote script URLs) holds.
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self' blob: ${RUNTIME_UI_SANDBOX_CSP_SOURCE}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`,
    );
    if (!this.validHost(req)) {
      this.json(res, 403, { error: "Unrecognized host" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/remote/login" && req.method === "POST") {
      if (!this.validOrigin(req)) {
        this.json(res, 403, { error: "Invalid origin" });
        return;
      }
      if (Date.now() - this.loginWindow > 60_000) {
        this.loginWindow = Date.now();
        this.loginAttempts = 0;
      }
      if (++this.loginAttempts > 12) {
        this.json(res, 429, { error: "Too many attempts. Wait a minute." });
        return;
      }
      let input: unknown;
      try {
        input = JSON.parse(await this.body(req, 2048)) as unknown;
      } catch {
        this.json(res, 400, { error: "Invalid request" });
        return;
      }
      const supplied =
        typeof input === "object" && input !== null && "secret" in input ? input.secret : null;
      if (
        typeof supplied !== "string" ||
        !timingSafeEqual(digest(supplied), digest(this.options.secret))
      ) {
        this.json(res, 401, { error: "Incorrect access key" });
        return;
      }
      const base = `${Date.now() + 30 * 86400_000}.${randomBytes(24).toString("base64url")}`;
      const secure = req.headers.origin?.startsWith("https://") ? "; Secure" : "";
      res.setHeader(
        "Set-Cookie",
        `${COOKIE}=${base}.${this.signature(base)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`,
      );
      this.json(res, 200, { success: true });
      return;
    }
    if (url.pathname === "/remote/status") {
      this.json(res, this.authenticated(req) ? 200 : 401, {
        authenticated: this.authenticated(req),
        ...(this.authenticated(req) ? { computerName: hostname() } : {}),
      });
      return;
    }
    if (url.pathname === "/remote/logout" && req.method === "POST") {
      if (!this.validOrigin(req)) {
        this.json(res, 403, {});
        return;
      }
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      this.json(res, 200, { success: true });
      return;
    }
    if (url.pathname === "/remote/upload" && req.method === "POST") {
      if (!this.authenticated(req) || !this.validOrigin(req)) {
        this.json(res, 403, {});
        return;
      }
      if (!this.options.uploadDir) {
        this.json(res, 503, { error: "File upload is unavailable" });
        return;
      }
      try {
        const input = z
          .object({ name: z.string().max(255), data: z.string().max(MAX_BYTES) })
          .parse(JSON.parse(await this.body(req, MAX_BYTES)) as unknown);
        if (
          typeof input.name !== "string" ||
          input.name.length > 255 ||
          typeof input.data !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)
        ) {
          this.json(res, 400, { error: "Invalid upload" });
          return;
        }
        const bytes = Buffer.from(input.data, "base64");
        if (bytes.length > 10 * 1024 * 1024) {
          this.json(res, 413, { error: "Files must be 10 MB or smaller" });
          return;
        }
        await mkdir(this.options.uploadDir, { recursive: true });
        const name = input.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180) || "attachment";
        const file = path.join(
          this.options.uploadDir,
          `${randomBytes(16).toString("hex")}-${name}`,
        );
        await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
        this.json(res, 200, { path: file });
      } catch {
        this.json(res, 400, { error: "Unable to upload file (10 MB maximum)" });
      }
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      this.json(res, 405, { error: "Method not allowed" });
      return;
    }
    if (url.pathname === "/remote/media") {
      if (!this.authenticated(req)) {
        this.json(res, 401, {});
        return;
      }
      const requested = url.searchParams.get("path");
      if (!requested) {
        this.json(res, 400, {});
        return;
      }
      try {
        const file = await realpath(requested);
        const roots = await Promise.all(
          (this.options.mediaRoots?.() ?? []).map((root) => realpath(root).catch(() => "")),
        );
        if (
          !roots.some((root) => root && file.startsWith(root + path.sep)) ||
          ![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(path.extname(file).toLowerCase())
        ) {
          this.json(res, 403, {});
          return;
        }
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_BYTES) {
          this.json(res, 413, {});
          return;
        }
        res.setHeader("content-type", mime[path.extname(file).toLowerCase()]);
        res.end(req.method === "HEAD" ? undefined : await readFile(file));
        return;
      } catch {
        this.json(res, 404, {});
        return;
      }
    }
    const relative = url.pathname === "/" ? "/remote.html" : decodeURIComponent(url.pathname);
    const file = path.resolve(this.options.rendererDir, "." + relative);
    if (
      !file.startsWith(path.resolve(this.options.rendererDir) + path.sep) ||
      relative.endsWith(".map")
    ) {
      this.json(res, 403, {});
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error("Not a file");
      const extension = path.extname(file);
      res.setHeader("content-type", mime[extension] ?? "application/octet-stream");
      // Vite content-hashes everything under /assets, so the phone can keep it
      // instead of re-downloading the whole app over Tailscale on every launch.
      if (relative.startsWith("/assets/"))
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      const encoding = compressible.has(extension) ? preferredEncoding(req) : null;
      if (compressible.has(extension)) res.setHeader("Vary", "Accept-Encoding");
      const body = encoding
        ? await this.compressedFile(file, info.mtimeMs, info.size, encoding)
        : await readFile(file);
      if (encoding) res.setHeader("Content-Encoding", encoding);
      res.setHeader("Content-Length", body.length);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      this.json(res, 404, { error: "Not found. Build Marshal with the remote entry first." });
    }
  }
  private compressedFile(
    file: string,
    mtimeMs: number,
    size: number,
    encoding: Encoding,
  ): Promise<Buffer> {
    const key = `${encoding}:${file}:${mtimeMs}:${size}`;
    let entry = this.compressed.get(key);
    if (!entry) {
      if (this.compressed.size >= COMPRESSED_CACHE_LIMIT) this.compressed.clear();
      entry = readFile(file).then((bytes) =>
        encoding === "br"
          ? brotli(bytes, {
              params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
                [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
              },
            })
          : gzipAsync(bytes, { level: 9 }),
      );
      void entry.catch(() => this.compressed.delete(key));
      this.compressed.set(key, entry);
    }
    return entry;
  }
  private accept(ws: WebSocket): void {
    const id = this.nextId--;
    this.sockets.set(id, ws);
    this.options.onConnect?.(id);
    this.alive.add(ws);
    ws.on("pong", () => this.alive.add(ws));
    // Sender identity for handlers that key state on event.sender (runtime-ui
    // subscriptions and in-flight invocations). Negative ids never collide
    // with renderer WebContents ids; "destroyed" fires on socket close so the
    // same teardown path runs for both surfaces.
    const destroyedListeners = new Set<() => void>();
    const sender: RemoteEventSender = {
      id,
      isDestroyed: () => ws.readyState !== WebSocket.OPEN,
      send: (channel, ...args) => this.send(ws, channel, args),
      once: (_event, listener) => destroyedListeners.add(listener),
      removeListener: (_event, listener) => destroyedListeners.delete(listener),
    };
    let pending = 0,
      count = 0,
      windowStart = Date.now();
    ws.on("message", (data) => {
      void (async () => {
        let request: { id: string; method: string; args: unknown[] };
        try {
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : data;
          const raw = z
            .object({
              type: z.literal("req"),
              id: z.string().max(100),
              method: z.string(),
              args: z.array(z.unknown()),
            })
            .parse(JSON.parse(bytes.toString("utf8")) as unknown);
          if (
            raw.type !== "req" ||
            typeof raw.id !== "string" ||
            raw.id.length > 100 ||
            typeof raw.method !== "string" ||
            !Array.isArray(raw.args)
          )
            throw Error();
          request = raw;
        } catch {
          ws.close(1008, "Invalid request");
          return;
        }
        if (Date.now() - windowStart > 1000) {
          windowStart = Date.now();
          count = 0;
        }
        if (++count > 100 || pending >= 64) {
          ws.close(1008, "Too many requests");
          return;
        }
        // Liveness probe from the phone, which cannot send protocol-level pings.
        if (request.method === "remote:ping") {
          ws.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload: {} }));
          return;
        }
        pending++;
        try {
          const args = validateRemoteArgs(request.method, request.args);
          const payload = await this.options.invoke(request.method, args, id, sender);
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
        } catch (error) {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                type: "res",
                id: request.id,
                ok: false,
                error: { message: error instanceof Error ? error.message : "Request failed" },
              }),
            );
        } finally {
          pending--;
        }
      })();
    });
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      this.sockets.delete(id);
      this.options.removeTarget(id);
      for (const listener of [...destroyedListeners]) listener();
      destroyedListeners.clear();
    });
  }
}
